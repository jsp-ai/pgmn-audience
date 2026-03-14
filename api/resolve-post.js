const https = require('https');
const { metaGet, AD_ACCOUNT_ID } = require('../lib/meta');

const PAGE_ID = (process.env.META_PAGE_ID || '394530007066390').trim();
const PAGE_ACCESS_TOKEN = (process.env.META_PAGE_ACCESS_TOKEN || '').trim().replace(/\\n$/, '');
let creativesCache = { data: null, ts: 0 };
let igAccountCache = { id: null, ts: 0 };
const CACHE_TTL = 300000; // 5 minutes

// Query FB Graph API with the page access token (needed for reading post details)
function pageGet(endpoint, params = {}) {
  const token = PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
  return new Promise((resolve, reject) => {
    params.access_token = token;
    const qs = new URLSearchParams(params).toString();
    const API_VERSION = process.env.META_API_VERSION || 'v25.0';
    const reqUrl = `https://graph.facebook.com/${API_VERSION}/${endpoint}?${qs}`;
    https.get(reqUrl, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: 'Invalid JSON' }); }
      });
    }).on('error', () => resolve({ error: 'Network error' }));
  });
}

// Detect @mentions in caption text
function detectMentions(caption) {
  if (!caption) return [];
  const matches = caption.match(/@[\w.]+/g);
  return matches || [];
}

// Resolve Facebook URL to numeric post ID
// Handles /share/p/ (redirect) and pfbid (HTML scrape for og:url) formats
function resolveFbPostId(inputUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(inputUrl);
      const isShareLink = /\/share\/p\//.test(parsed.pathname);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: isShareLink ? 'HEAD' : 'GET',
        headers: { 'User-Agent': 'facebookexternalhit/1.1' }, // Get meta tags without full page
      }, (res) => {
        // Handle redirects (e.g., /share/p/ → story.php?story_fbid=...)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const storyMatch = res.headers.location.match(/story_fbid=(\d+)/);
          if (storyMatch) { res.resume(); resolve(storyMatch[1]); return; }
        }
        if (isShareLink) { res.resume(); resolve(null); return; }
        // Read just enough HTML to find og:url or canonical (in <head>)
        let data = '';
        let found = false;
        res.on('data', chunk => {
          if (found) return;
          data += chunk;
          // Check after each chunk — meta tags are in first ~10KB
          const canonicalMatch = data.match(/\/posts\/[^"]*\/(\d{10,})\//);
          if (canonicalMatch) { found = true; res.destroy(); resolve(canonicalMatch[1]); return; }
          const storyMatch = data.match(/story_fbid=(\d+)/);
          if (storyMatch) { found = true; res.destroy(); resolve(storyMatch[1]); return; }
          if (data.length > 20000) { res.destroy(); resolve(null); }
        });
        res.on('end', () => { if (!found) resolve(null); });
        res.on('error', () => { if (!found) resolve(null); });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(6000, () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}

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
    let resolvedUrl = url;
    const igMatch = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
    if (igMatch) urlId = igMatch[1];
    const fbPostMatch = url.match(/\/posts\/(\d+)/);
    if (fbPostMatch) urlId = fbPostMatch[1];
    const fbVideoMatch = url.match(/\/videos\/(\d+)/);
    if (fbVideoMatch) urlId = fbVideoMatch[1];
    const fbReelMatch = url.match(/facebook\.com\/(?:[\w.]+\/)?reel\/(\d+)/);
    if (fbReelMatch) urlId = fbReelMatch[1];
    const storyFbidMatch = url.match(/story_fbid=(\d+)/);
    if (storyFbidMatch) urlId = storyFbidMatch[1];
    const fbidMatch = url.match(/[?&]fbid=(\d+)/);
    if (fbidMatch) urlId = fbidMatch[1];
    const pfbidMatch = url.match(/(pfbid[A-Za-z0-9]+)/);
    if (pfbidMatch) urlId = pfbidMatch[1];

    // Handle /share/p/ and pfbid URLs by resolving to numeric post ID
    if (!isInstagram && (!urlId || /^pfbid/.test(urlId))) {
      const numericId = await resolveFbPostId(url);
      if (numericId) urlId = numericId;
    }

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
      // Check source_instagram_media_id FIRST (IG-native creatives)
      if (matched.source_instagram_media_id) {
        const igAccountId = await getIgAccountId();
        return res.status(200).json({
          resolved: true,
          ig_media_id: matched.source_instagram_media_id,
          ig_account_id: igAccountId,
          creative_id: matched.id,
          caption: matched.body || matched.title || matched.name || '',
          thumbnail: matched.thumbnail_url || null, platform, content_type,
          use_ig_media: true,
          source: 'ad_creatives_ig',
        });
      } else if (matched.object_story_id && !isInstagram) {
        // FB creative — only use object_story_id for Facebook URLs
        const postId = matched.object_story_id.includes('_') ? matched.object_story_id.split('_')[1] : matched.object_story_id;
        return res.status(200).json({
          resolved: true, object_story_id: matched.object_story_id, post_id: postId,
          creative_id: matched.id,
          caption: matched.body || matched.title || matched.name || '',
          thumbnail: matched.thumbnail_url || null, platform, content_type,
          source: 'ad_creatives',
        });
      }
      // If IG URL matched a creative with only object_story_id (old format),
      // skip it and fall through to Step 3 (IG Graph API) for proper handling
    }

    // ─── Step 2: For Facebook posts, construct object_story_id from extracted ID ───
    if (!isInstagram && urlId && /^\d+$/.test(urlId)) {
      const objectStoryId = `${PAGE_ID}_${urlId}`;
      const result = {
        resolved: true,
        object_story_id: objectStoryId,
        post_id: urlId,
        platform, content_type,
        source: 'fb_post_lookup',
        warnings: [],
      };

      // Try to query the actual post for tags, caption, and type info
      try {
        const post = await pageGet(objectStoryId, {
          fields: 'message,message_tags,to,story_tags,is_eligible_for_promotion,full_picture'
        });
        if (!post.error) {
          if (post.message) result.caption = post.message;
          if (post.full_picture) result.thumbnail = post.full_picture;
          // Detect tagged users/pages
          const hasTags = (post.message_tags && post.message_tags.length > 0)
            || (post.to && post.to.data && post.to.data.length > 0)
            || (post.story_tags && Object.keys(post.story_tags).length > 0);
          if (hasTags) {
            result.warnings.push('This post has tagged users/pages. Meta may reject boosting tagged posts — remove tags before launching.');
          }
          // Check @mentions in caption as fallback
          const mentions = detectMentions(post.message);
          if (!hasTags && mentions.length > 0) {
            result.warnings.push(`Post mentions ${mentions.join(', ')} — tagged content may be restricted from boosting.`);
          }
        }
      } catch (e) { /* post query failed, continue without warnings */ }

      return res.status(200).json(result);
    }

    // ─── Step 3: For Instagram, try IG Graph API media lookup ───
    // Requires instagram_basic permission (may fail)
    if (isInstagram && urlId) {
      try {
        const igAccountId = await getIgAccountId();
        if (igAccountId) {
          // Paginate through media to find the post (up to 3 pages / ~150 posts)
          let igMatched = null;
          let nextUrl = null;
          const mediaFields = 'id,ig_id,shortcode,permalink,caption,media_type,thumbnail_url,media_url';

          for (let page = 0; page < 3; page++) {
            let igMedia;
            if (page === 0) {
              igMedia = await metaGet(`${igAccountId}/media`, { fields: mediaFields, limit: '50' });
            } else if (nextUrl) {
              // Fetch next page directly via full URL
              igMedia = await new Promise((resolve, reject) => {
                https.get(nextUrl, r => {
                  let d = '';
                  r.on('data', c => d += c);
                  r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
                }).on('error', () => resolve({}));
              });
            } else { break; }

            if (igMedia.error || !igMedia.data) break;

            for (const m of igMedia.data) {
              if (m.shortcode === urlId || (m.permalink && m.permalink.includes(urlId))) {
                igMatched = m;
                break;
              }
            }
            if (igMatched) break;
            nextUrl = igMedia.paging && igMedia.paging.next ? igMedia.paging.next : null;
            if (!nextUrl) break;
          }

          if (igMatched) {
              // For carousel posts, get children count to check for >10 slide limit
              let childrenCount = 0;
              if (igMatched.media_type === 'CAROUSEL_ALBUM') {
                try {
                  const children = await metaGet(`${igMatched.id}/children`, { fields: 'id', limit: '50' });
                  if (children.data) childrenCount = children.data.length;
                } catch (e) { /* ignore */ }
              }

              const warnings = [];
              if (childrenCount > 10) {
                warnings.push(`Carousel has ${childrenCount} slides — Meta Ads max is 10. This post cannot be boosted.`);
              }
              // Check for @mentions and collabs in caption
              const mentions = detectMentions(igMatched.caption);
              if (mentions.length > 0) {
                warnings.push(`Post mentions ${mentions.join(', ')} — tagged or collab posts may be restricted from boosting.`);
              }

              const result = {
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
                warnings,
              };
              if (childrenCount > 0) result.children_count = childrenCount;
              // Keep backward compat single warning field
              if (childrenCount > 10) result.warning = warnings[0];
              return res.status(200).json(result);
            }
        }
      } catch (igErr) {
        // IG lookup failed (likely missing instagram_basic permission)
      }
    }

    // ─── Not found ───
    return res.status(200).json({
      resolved: false, url_id: urlId, platform, content_type,
      message: 'Post not found. Make sure the URL is correct and the post belongs to your connected Instagram/Facebook account.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
