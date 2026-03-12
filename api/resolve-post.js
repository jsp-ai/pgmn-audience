const { metaGet, AD_ACCOUNT_ID } = require('../lib/meta');

const PAGE_ID = process.env.META_PAGE_ID || '394530007066390';
let creativesCache = { data: null, ts: 0 };
let igAccountCache = { id: null, ts: 0 };
const CACHE_TTL = 300000; // 5 minutes

// Get IG Business Account ID (cached)
async function getIgAccountId() {
  if (igAccountCache.id && Date.now() - igAccountCache.ts < CACHE_TTL) {
    return igAccountCache.id;
  }
  try {
    const pageData = await metaGet(PAGE_ID, { fields: 'instagram_business_account' });
    if (pageData.instagram_business_account) {
      igAccountCache = { id: pageData.instagram_business_account.id, ts: Date.now() };
      return igAccountCache.id;
    }
  } catch (e) { /* ignore */ }
  return null;
}

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

    // ─── Step 1: Check ad creatives (cached) ───
    // Includes source_instagram_media_id for IG-native creatives
    let creatives;
    if (creativesCache.data && Date.now() - creativesCache.ts < CACHE_TTL) {
      creatives = creativesCache.data;
    } else {
      const result = await metaGet(`${AD_ACCOUNT_ID}/adcreatives`, {
        fields: 'id,name,object_story_id,thumbnail_url,title,body,instagram_permalink_url,source_instagram_media_id',
        limit: '50'
      });
      creatives = result.data || [];
      creativesCache = { data: creatives, ts: Date.now() };
    }

    // Match URL against creatives — check ALL creatives (not just those with object_story_id)
    let matched = null;
    for (const c of creatives) {
      if (urlId && c.instagram_permalink_url && c.instagram_permalink_url.includes(urlId)) { matched = c; break; }
      if (urlId && c.object_story_id && c.object_story_id.includes(urlId)) { matched = c; break; }
    }

    if (matched) {
      // Two cases: creative with object_story_id (FB boost) or source_instagram_media_id (IG native)
      if (matched.object_story_id) {
        const postId = matched.object_story_id.includes('_') ? matched.object_story_id.split('_')[1] : matched.object_story_id;
        return res.status(200).json({
          resolved: true, object_story_id: matched.object_story_id, post_id: postId,
          caption: matched.body || matched.title || matched.name || '',
          thumbnail: matched.thumbnail_url || null, platform, content_type,
          source: 'ad_creatives',
        });
      } else if (matched.source_instagram_media_id) {
        // IG-native creative — use instagram_actor_id + source_instagram_media_id approach
        const igAccountId = await getIgAccountId();
        return res.status(200).json({
          resolved: true,
          ig_media_id: matched.source_instagram_media_id,
          ig_account_id: igAccountId,
          caption: matched.body || matched.title || matched.name || '',
          thumbnail: matched.thumbnail_url || null, platform, content_type,
          use_ig_media: true,
          source: 'ad_creatives_ig',
        });
      }
    }

    // ─── Step 2: For Instagram, try IG Graph API media lookup ───
    // Requires instagram_basic permission (may fail)
    if (isInstagram && urlId) {
      try {
        const igAccountId = await getIgAccountId();
        if (igAccountId) {
          const igMedia = await metaGet(`${igAccountId}/media`, {
            fields: 'id,ig_id,shortcode,permalink,caption,media_type,thumbnail_url,media_url',
            limit: '50'
          });

          if (!igMedia.error && igMedia.data) {
            let igMatched = null;
            for (const m of igMedia.data) {
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
                source: 'ig_media',
              });
            }
          }
        }
      } catch (igErr) {
        // IG lookup failed (likely missing instagram_basic permission)
      }
    }

    // ─── Not found ───
    // Include debug info: first 3 creatives' permalink URLs and count
    const debugCreatives = creatives.slice(0, 3).map(c => ({
      id: c.id,
      permalink: c.instagram_permalink_url || null,
      sid: c.source_instagram_media_id || null,
      oid: c.object_story_id ? 'yes' : 'no',
    }));
    return res.status(200).json({
      resolved: false, url_id: urlId, platform, content_type,
      creatives_checked: creatives.length,
      debug_top3: debugCreatives,
      message: 'Post not found in ad creatives. It needs to be promoted at least once via Meta Business Suite before it can be used here, or add instagram_basic permission to the app token.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
