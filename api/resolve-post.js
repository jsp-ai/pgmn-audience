const { metaGet, AD_ACCOUNT_ID } = require('../lib/meta');

let creativesCache = { data: null, ts: 0 };
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

    // Load creatives (cached)
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

    // Try to match URL against creatives
    let matched = null;
    for (const c of creatives) {
      if (!c.object_story_id) continue;
      // Match by instagram_permalink_url containing the shortcode
      if (urlId && c.instagram_permalink_url && c.instagram_permalink_url.includes(urlId)) {
        matched = c;
        break;
      }
      // Match by object_story_id containing the numeric ID
      if (urlId && c.object_story_id.includes(urlId)) {
        matched = c;
        break;
      }
    }

    if (matched) {
      const postId = matched.object_story_id.includes('_')
        ? matched.object_story_id.split('_')[1]
        : matched.object_story_id;
      return res.status(200).json({
        resolved: true,
        object_story_id: matched.object_story_id,
        post_id: postId,
        caption: matched.body || matched.title || matched.name || '',
        thumbnail: matched.thumbnail_url || null,
        platform,
        content_type,
      });
    }

    // Not found in creatives — return what we can
    return res.status(200).json({
      resolved: false,
      url_id: urlId,
      platform,
      content_type,
      message: 'Post not found in promoted creatives. It may need to be promoted first via Meta Business Suite.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
