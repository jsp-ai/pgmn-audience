const { metaGet, AD_ACCOUNT_ID } = require('../lib/meta');

let postsCache = { data: null, ts: 0 };
const CACHE_TTL = 300000; // 5 minutes

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const nocache = req.query?.nocache === '1' || new URL(req.url, 'http://localhost').searchParams.get('nocache') === '1';
  if (!nocache && postsCache.data && Date.now() - postsCache.ts < CACHE_TTL) {
    return res.status(200).json(postsCache.data);
  }

  try {
    const creatives = await metaGet(`${AD_ACCOUNT_ID}/adcreatives`, {
      fields: 'id,name,object_story_id,thumbnail_url,title,body,instagram_permalink_url',
      limit: '30'
    });

    const seen = new Set();
    const facebook = [];
    const instagram = [];
    for (const c of (creatives.data || [])) {
      if (!c.object_story_id) continue;
      const postId = c.object_story_id.includes('_') ? c.object_story_id.split('_')[1] : c.object_story_id;
      if (seen.has(postId)) continue;
      seen.add(postId);
      const post = {
        id: c.object_story_id,
        post_id: postId,
        message: c.body || c.title || c.name || '',
        thumbnail: c.thumbnail_url || null,
        platform: c.instagram_permalink_url ? 'instagram' : 'facebook'
      };
      if (post.platform === 'instagram') instagram.push(post);
      else facebook.push(post);
    }

    const result = { facebook, instagram };
    postsCache = { data: result, ts: Date.now() };
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
