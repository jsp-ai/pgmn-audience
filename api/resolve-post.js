const { metaGet, AD_ACCOUNT_ID } = require('../lib/meta');

const PAGE_ID = process.env.META_PAGE_ID || '394530007066390';
let creativesCache = { data: null, ts: 0 };
let igAccountCache = { id: null, ts: 0 };
const CACHE_TTL = 300000; // 5 minutes

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.query?.url || new URL(req.url, 'http://localhost').searchParams.get('url');
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  try {
    // Detect content type from URL
    const isReel = /\/(reel|reels)\//i.test(url) || /\/videos\//i.test(url);
    const isInstagram = url.includes('instagram.com');
    const platform = isInstagram ? 'instagram' : 'facebook';
    const content_type = isReel ? 'reel' : 'post';

    // Extract shortcode or post ID from URL
    let urlId = null;
    const igMatch = url.match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
    if (igMatch) urlId = igMatch[1];
    const fbPostMatch = url.match(/\/posts\/(\d+)/);
    if (fbPostMatch) urlId = fbPostMatch[1];
    const fbVideoMatch = url.match(/\/videos\/(\d+)/);
    if (fbVideoMatch) urlId = fbVideoMatch[1];
    const pfbidMatch = url.match(/(pfbid[A-Za-z0-9]+)/);
    if (pfbidMatch) urlId = pfbidMatch[1];

    // Step 1: Check ad creatives (cached)
    let creatives;
    if (creativesCache.data && Date.now() - creativesCache.ts < CACHE_TTL) {
      creatives = creativesCache.data;
    } else {
      const result = await metaGet(`${AD_ACCOUNT_ID}/adcreatives`, {
        fields: 'id,name,object_story_id,thumbnail_url,title,body,instagram_permalink_url',
        limit: '50'
      });
      creatives = result.data || [];
      creativesCache = { data: creatives, ts: Date.now() };
    }

    // Match URL against creatives
    let matched = null;
    for (const c of creatives) {
      if (!c.object_story_id) continue;
      if (urlId && c.instagram_permalink_url && c.instagram_permalink_url.includes(urlId)) { matched = c; break; }
      if (urlId && c.object_story_id.includes(urlId)) { matched = c; break; }
    }

    if (matched) {
      const postId = matched.object_story_id.includes('_') ? matched.object_story_id.split('_')[1] : matched.object_story_id;
      return res.status(200).json({
        resolved: true, object_story_id: matched.object_story_id, post_id: postId,
        caption: matched.body || matched.title || matched.name || '',
        thumbnail: matched.thumbnail_url || null, platform, content_type,
      });
    }

    // Step 2: For Instagram posts, try Instagram Graph API lookup
    if (isInstagram && urlId) {
      try {
        // Get Instagram Business Account ID from the Page (cached)
        let igAccountId = null;
        if (igAccountCache.id && Date.now() - igAccountCache.ts < CACHE_TTL) {
          igAccountId = igAccountCache.id;
        } else {
          const pageData = await metaGet(PAGE_ID, { fields: 'instagram_business_account' });
          if (pageData.instagram_business_account) {
            igAccountId = pageData.instagram_business_account.id;
            igAccountCache = { id: igAccountId, ts: Date.now() };
          }
        }

        if (igAccountId) {
          // Fetch recent IG media and match by shortcode/permalink
          const igMedia = await metaGet(`${igAccountId}/media`, {
            fields: 'id,ig_id,shortcode,permalink,caption,media_type,thumbnail_url,media_url',
            limit: '50'
          });

          let igMatched = null;
          for (const m of (igMedia.data || [])) {
            if (m.shortcode === urlId || (m.permalink && m.permalink.includes(urlId))) {
              igMatched = m;
              break;
            }
          }

          if (igMatched) {
            return res.status(200).json({
              resolved: true,
              ig_media_id: igMatched.id,
              ig_id: igMatched.ig_id || igMatched.id,
              ig_account_id: igAccountId,
              caption: igMatched.caption || '',
              thumbnail: igMatched.thumbnail_url || igMatched.media_url || null,
              media_type: igMatched.media_type,
              platform, content_type,
              use_ig_media: true,
            });
          }
        }
      } catch (igErr) {
        // IG lookup failed — fall through to unresolved
      }
    }

    // Not found anywhere
    return res.status(200).json({
      resolved: false, url_id: urlId, platform, content_type,
      message: 'Post not found. Ensure it was published from your PGMN page.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
