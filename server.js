const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// Load .env
const envPath = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) env[key.trim()] = val.join('=').trim();
  });
}

const ACCESS_TOKEN = env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = env.META_AD_ACCOUNT_ID;
const API_VERSION = env.META_API_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

// ─── Meta API helpers ───

function metaGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    params.access_token = ACCESS_TOKEN;
    const qs = new URLSearchParams(params).toString();
    const reqUrl = `${BASE}/${endpoint}?${qs}`;
    https.get(reqUrl, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Meta API')); }
      });
    }).on('error', reject);
  });
}

function metaPost(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    body.access_token = ACCESS_TOKEN;
    const postData = new URLSearchParams(body).toString();
    const parsed = new URL(`${BASE}/${endpoint}`);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Meta API')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const PAGE_ID = (env.META_PAGE_ID || '394530007066390').trim();
const PAGE_ACCESS_TOKEN = env.META_PAGE_ACCESS_TOKEN || '';
const IG_ACCOUNT_ID = (env.META_IG_ACCOUNT_ID || '').trim();

// Query with page access token (for reading post details)
function pageGet(endpoint, params = {}) {
  const token = PAGE_ACCESS_TOKEN || ACCESS_TOKEN;
  return new Promise((resolve) => {
    params.access_token = token;
    const qs = new URLSearchParams(params).toString();
    const reqUrl = `${BASE}/${endpoint}?${qs}`;
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

// Get the IG actor ID for ad creatives — returns { id, source } for debugging
let igActorCache = { id: null, source: null, ts: 0 };
async function getIgActorId() {
  if (igActorCache.id && Date.now() - igActorCache.ts < 300000) {
    return { id: igActorCache.id, source: igActorCache.source };
  }

  // 0. Environment variable
  if (IG_ACCOUNT_ID) {
    igActorCache = { id: IG_ACCOUNT_ID, source: 'env_var', ts: Date.now() };
    return { id: IG_ACCOUNT_ID, source: 'env_var' };
  }

  // 1. Try Page-level instagram_accounts with Page Access Token
  try {
    const pageIg = await pageGet(`${PAGE_ID}/instagram_accounts`, { fields: 'id,username' });
    if (pageIg.data && pageIg.data.length > 0) {
      const id = pageIg.data[0].id;
      igActorCache = { id, source: `page_ig(${pageIg.data[0].username || 'unknown'})`, ts: Date.now() };
      return { id, source: igActorCache.source };
    }
  } catch (e) { /* continue */ }

  // 2. Try page-backed IG accounts
  try {
    const backed = await pageGet(`${PAGE_ID}/page_backed_instagram_accounts`);
    if (backed.data && backed.data.length > 0) {
      const id = backed.data[0].id;
      igActorCache = { id, source: 'page_backed', ts: Date.now() };
      return { id, source: 'page_backed' };
    }
  } catch (e) { /* continue */ }

  // 3. Fallback: ad account level
  try {
    const adIg = await metaGet(`${AD_ACCOUNT_ID}/instagram_accounts`, { fields: 'id,username' });
    if (adIg.data && adIg.data.length > 0) {
      const id = adIg.data[0].id;
      igActorCache = { id, source: `ad_account(${adIg.data[0].username || 'unknown'})`, ts: Date.now() };
      return { id, source: igActorCache.source };
    }
  } catch (e) { /* continue */ }

  return null;
}

// ─── Cache (avoid Meta API rate limits) ───
const cache = {};
const CACHE_TTL = 120000; // 2 minutes

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// ─── API Route Handlers ───

async function getCampaigns(limit = 30) {
  const cached = getCached('campaigns');
  if (cached) return cached;

  const campaigns = await metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
    fields: 'name,status,objective,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining',
    limit: String(limit)
  });

  const campIds = (campaigns.data || []).map(c => c.id);
  if (!campIds.length) return { data: [], paging: campaigns.paging };

  // Adset budgets (wrapped in try/catch to handle rate limits gracefully)
  const budgetMap = {};
  try {
    const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
      fields: 'campaign_id,lifetime_budget,daily_budget',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
      limit: '200'
    });
    for (const as of (adsets.data || [])) {
      if (!budgetMap[as.campaign_id]) budgetMap[as.campaign_id] = 0;
      if (as.lifetime_budget) budgetMap[as.campaign_id] += parseInt(as.lifetime_budget) / 100;
      else if (as.daily_budget) budgetMap[as.campaign_id] += parseInt(as.daily_budget) / 100;
    }
  } catch (e) { /* adset budget lookup failed, continue without */ }

  // Insights
  const insightFields = [
    'campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'actions', 'clicks'
  ].join(',');
  const insights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
    fields: insightFields, date_preset: 'maximum', level: 'campaign',
    filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
    limit: '100'
  });
  const insightsMap = {};
  for (const row of (insights.data || [])) {
    const spend = parseFloat(row.spend || 0);
    let engagements = 0, videoViews = 0;
    for (const action of (row.actions || [])) {
      if (action.action_type === 'post_engagement') engagements = parseInt(action.value);
      if (action.action_type === 'video_view') videoViews = parseInt(action.value);
    }
    insightsMap[row.campaign_id] = {
      spend, impressions: parseInt(row.impressions || 0),
      reach: parseInt(row.reach || 0), clicks: parseInt(row.clicks || 0),
      engagements, video_views: videoViews,
      eng_per_peso: spend > 0 ? Math.round(engagements / spend * 100) / 100 : 0
    };
  }

  const now = new Date();
  const enriched = (campaigns.data || []).map(c => {
    let totalBudget = null;
    if (c.lifetime_budget) totalBudget = parseInt(c.lifetime_budget) / 100;
    else if (c.daily_budget) totalBudget = parseInt(c.daily_budget) / 100;
    else if (budgetMap[c.id]) totalBudget = budgetMap[c.id];
    return { ...c, total_budget: totalBudget, insights: insightsMap[c.id] || null };
  }).filter(c => {
    // Exclude campaigns past their end date
    if (c.stop_time && new Date(c.stop_time) < now) return false;
    // Exclude campaigns that have spent 100% of budget
    const spent = c.insights ? c.insights.spend : 0;
    if (c.total_budget && spent >= c.total_budget) return false;
    return true;
  });
  const result = { data: enriched, paging: campaigns.paging };
  setCache('campaigns', result);
  return result;
}

async function getActiveCampaigns() {
  return metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
    fields: 'name,status,objective,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining',
    effective_status: JSON.stringify(['ACTIVE']),
    limit: '50'
  });
}

async function getCampaignInsights(campaignId) {
  const fields = [
    'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
    'actions', 'cost_per_action_type', 'cpm', 'cpp', 'ctr',
    'clicks', 'unique_clicks'
  ].join(',');
  const result = await metaGet(`${campaignId}/insights`, { fields, date_preset: 'lifetime' });
  if (result.data && result.data[0]) return calculateMetrics(result.data[0]);
  return { message: 'No data available yet' };
}

async function getStats() {
  const cached = getCached('stats');
  if (cached) return cached;

  const active = await metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
    fields: 'id,stop_time,daily_budget,lifetime_budget',
    effective_status: JSON.stringify(['ACTIVE']),
    limit: '100'
  });
  const campaigns = active.data || [];
  const campIds = campaigns.map(c => c.id);

  let budgetMap = {};
  let spendMap = {};
  if (campIds.length) {
    const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
      fields: 'campaign_id,lifetime_budget,daily_budget',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
      limit: '200'
    });
    for (const as of (adsets.data || [])) {
      if (!budgetMap[as.campaign_id]) budgetMap[as.campaign_id] = 0;
      if (as.lifetime_budget) budgetMap[as.campaign_id] += parseInt(as.lifetime_budget) / 100;
      else if (as.daily_budget) budgetMap[as.campaign_id] += parseInt(as.daily_budget) / 100;
    }
    const spendInsights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
      fields: 'campaign_id,spend',
      date_preset: 'maximum',
      level: 'campaign',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
      limit: '200'
    });
    for (const row of (spendInsights.data || [])) {
      spendMap[row.campaign_id] = parseFloat(row.spend || 0);
    }
  }

  const now = new Date();
  const activeCount = campaigns.filter(c => {
    if (c.stop_time && new Date(c.stop_time) < now) return false;
    let totalBudget = null;
    if (c.lifetime_budget) totalBudget = parseInt(c.lifetime_budget) / 100;
    else if (c.daily_budget) totalBudget = parseInt(c.daily_budget) / 100;
    else if (budgetMap[c.id]) totalBudget = budgetMap[c.id];
    const spent = spendMap[c.id] || 0;
    if (totalBudget && spent >= totalBudget) return false;
    return true;
  }).length;

  const todayInsights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
    fields: 'spend', date_preset: 'today'
  });
  const todaySpend = todayInsights.data && todayInsights.data[0]
    ? parseFloat(todayInsights.data[0].spend || 0) : 0;

  const monthInsights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
    fields: 'spend', date_preset: 'this_month'
  });
  const monthSpend = monthInsights.data && monthInsights.data[0]
    ? parseFloat(monthInsights.data[0].spend || 0) : 0;

  const statsResult = {
    active_count: activeCount,
    total_daily_spend: Math.round(todaySpend * 100) / 100,
    total_monthly_spend: Math.round(monthSpend * 100) / 100
  };
  setCache('stats', statsResult);
  return statsResult;
}

function calculateMetrics(insight) {
  const spend = parseFloat(insight.spend || 0);
  const impressions = parseInt(insight.impressions || 0);
  const reach = parseInt(insight.reach || 0);
  const clicks = parseInt(insight.clicks || 0);
  let engagements = 0, shares = 0, comments = 0, videoViews = 0;
  for (const action of (insight.actions || [])) {
    if (action.action_type === 'post_engagement') engagements = parseInt(action.value);
    if (action.action_type === 'post') shares = parseInt(action.value);
    if (action.action_type === 'comment') comments = parseInt(action.value);
    if (action.action_type === 'video_view') videoViews = parseInt(action.value);
  }
  return {
    campaign_name: insight.campaign_name,
    campaign_id: insight.campaign_id,
    spend, impressions, reach, clicks, engagements, shares, comments, video_views: videoViews,
    cpm: impressions > 0 ? Math.round(spend / impressions * 1000 * 100) / 100 : 0,
    eng_per_peso: spend > 0 ? Math.round(engagements / spend * 100) / 100 : 0,
    virality: engagements > 0 ? Math.round((shares + comments) / engagements * 10000) / 10000 : 0,
  };
}

async function getIgAccountId() {
  try {
    const pageData = await pageGet(PAGE_ID, { fields: 'instagram_business_account' });
    if (pageData.instagram_business_account) return pageData.instagram_business_account.id;
  } catch (e) { /* ignore */ }
  return null;
}

function detectMentions(caption) {
  if (!caption) return [];
  return caption.match(/@[\w.]+/g) || [];
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
        headers: { 'User-Agent': 'facebookexternalhit/1.1' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const storyMatch = res.headers.location.match(/story_fbid=(\d+)/);
          if (storyMatch) { res.resume(); resolve(storyMatch[1]); return; }
        }
        if (isShareLink) { res.resume(); resolve(null); return; }
        let data = '';
        let found = false;
        res.on('data', chunk => {
          if (found) return;
          data += chunk;
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

async function resolvePost(postUrl) {
  const isReelUrl = /\/(reel|reels)\//i.test(postUrl) || /\/videos\//i.test(postUrl);
  const isInstagram = postUrl.includes('instagram.com');
  const platform = isInstagram ? 'instagram' : 'facebook';
  let content_type = isReelUrl ? 'reel' : 'post';

  let urlId = null;
  const igMatch = postUrl.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  if (igMatch) urlId = igMatch[1];
  const fbPostMatch = postUrl.match(/\/posts\/(\d+)/);
  if (fbPostMatch) urlId = fbPostMatch[1];
  const fbVideoMatch = postUrl.match(/\/videos\/(\d+)/);
  if (fbVideoMatch) urlId = fbVideoMatch[1];
  const fbReelMatch = postUrl.match(/facebook\.com\/(?:[\w.]+\/)?reel\/(\d+)/);
  if (fbReelMatch) urlId = fbReelMatch[1];
  const storyFbidMatch = postUrl.match(/story_fbid=(\d+)/);
  if (storyFbidMatch) urlId = storyFbidMatch[1];
  const fbidMatch = postUrl.match(/[?&]fbid=(\d+)/);
  if (fbidMatch) urlId = fbidMatch[1];
  const pfbidMatch = postUrl.match(/(pfbid[A-Za-z0-9]+)/);
  if (pfbidMatch) urlId = pfbidMatch[1];

  // Handle /share/p/ and pfbid URLs by resolving to numeric post ID
  if (!isInstagram && (!urlId || /^pfbid/.test(urlId))) {
    const numericId = await resolveFbPostId(postUrl);
    if (numericId) urlId = numericId;
  }

  // ─── Step 1: Check ad creatives (includes source_instagram_media_id) ───
  const creatives = await metaGet(`${AD_ACCOUNT_ID}/adcreatives`, {
    fields: 'id,name,object_story_id,thumbnail_url,title,body,instagram_permalink_url,source_instagram_media_id',
    limit: '50'
  });

  let matched = null;
  for (const c of (creatives.data || [])) {
    if (urlId && c.instagram_permalink_url && c.instagram_permalink_url.includes(urlId)) { matched = c; break; }
    if (urlId && c.object_story_id && c.object_story_id.includes(urlId)) { matched = c; break; }
  }

  if (matched) {
    // Check source_instagram_media_id FIRST (IG-native creatives)
    if (matched.source_instagram_media_id) {
      const igAccountId = await getIgAccountId();
      return {
        resolved: true, ig_media_id: matched.source_instagram_media_id, ig_account_id: igAccountId,
        creative_id: matched.id,
        caption: matched.body || matched.title || matched.name || '', thumbnail: matched.thumbnail_url || null,
        platform, content_type, use_ig_media: true, source: 'ad_creatives_ig',
      };
    } else if (matched.object_story_id && !isInstagram) {
      // FB creative — only use object_story_id for Facebook URLs
      const postId = matched.object_story_id.includes('_') ? matched.object_story_id.split('_')[1] : matched.object_story_id;
      return { resolved: true, object_story_id: matched.object_story_id, post_id: postId, creative_id: matched.id, caption: matched.body || matched.title || matched.name || '', thumbnail: matched.thumbnail_url || null, platform, content_type, source: 'ad_creatives' };
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
    // First try as video (for reels/videos) — full_picture is deprecated on post objects
    try {
      const video = await pageGet(urlId, { fields: 'description,thumbnails{uri,is_preferred},picture' });
      if (!video.error && (video.thumbnails || video.picture)) {
        if (video.description) result.caption = video.description;
        const preferred = video.thumbnails && video.thumbnails.data
          ? video.thumbnails.data.find(t => t.is_preferred) || video.thumbnails.data[0]
          : null;
        result.thumbnail = (preferred && preferred.uri) || video.picture || null;
        content_type = 'reel';
        result.content_type = content_type;
      }
    } catch (e) { /* not a video */ }

    // Then try as post for tags/mentions
    try {
      const post = await pageGet(objectStoryId, {
        fields: 'message,message_tags,to,story_tags'
      });
      if (!post.error) {
        if (post.message && !result.caption) result.caption = post.message;
        const hasTags = (post.message_tags && post.message_tags.length > 0)
          || (post.to && post.to.data && post.to.data.length > 0)
          || (post.story_tags && Object.keys(post.story_tags).length > 0);
        if (hasTags) {
          result.warnings.push('This post has tagged users/pages. Meta may reject boosting tagged or collab posts — remove tags before launching.');
        }
        const mentions = detectMentions(post.message);
        if (!hasTags && mentions.length > 0) {
          result.warnings.push(`Post mentions ${mentions.join(', ')} — tagged or collab content may be restricted from boosting.`);
        }
      }
    } catch (e) { /* post query failed */ }
    return result;
  }

  // ─── Step 3: IG Graph API media lookup (requires instagram_basic) ───
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
            igMedia = await pageGet(`${igAccountId}/media`, { fields: mediaFields, limit: '50' });
          } else if (nextUrl) {
            igMedia = await new Promise((resolve) => {
              https.get(nextUrl, r => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
              }).on('error', () => resolve({}));
            });
          } else { break; }

          if (igMedia.error || !igMedia.data) break;
          for (const m of igMedia.data) {
            if (m.shortcode === urlId || (m.permalink && m.permalink.includes(urlId))) { igMatched = m; break; }
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
                const children = await pageGet(`${igMatched.id}/children`, { fields: 'id', limit: '50' });
                if (children.data) childrenCount = children.data.length;
              } catch (e) { /* ignore */ }
            }

            const warnings = [];
            if (childrenCount > 10) {
              warnings.push(`Carousel has ${childrenCount} slides — Meta Ads max is 10. This post cannot be boosted.`);
            }
            const mentions = detectMentions(igMatched.caption);
            if (mentions.length > 0) {
              warnings.push(`Post mentions ${mentions.join(', ')} — tagged or collab posts may be restricted from boosting.`);
            }

            // If IG media is VIDEO, override content_type to 'reel' for ThruPlay optimization
            if (igMatched.media_type === 'VIDEO') {
              content_type = 'reel';
            }
            const result = {
              resolved: true, ig_media_id: igMatched.id, ig_id: igMatched.ig_id || igMatched.id,
              ig_account_id: igAccountId, caption: igMatched.caption || '',
              thumbnail: igMatched.thumbnail_url || igMatched.media_url || null,
              media_type: igMatched.media_type, platform, content_type,
              use_ig_media: true, source: 'ig_media', warnings,
            };
            if (childrenCount > 0) result.children_count = childrenCount;
            if (childrenCount > 10) result.warning = warnings[0];
            return result;
          }
      }
    } catch (e) { /* IG lookup failed */ }
  }

  return { resolved: false, url_id: urlId, platform, content_type, message: 'Post not found. Make sure the URL is correct and the post belongs to your connected Instagram/Facebook account.' };
}

async function launchCampaign(body) {
  const {
    budget_php, duration_days, page_id, post_id, campaign_name,
    platform, ab_test, political, countries, cities, content_type,
    object_story_id, creative_id,
    use_ig_media, ig_media_id, ig_account_id,
  } = body;
  const name = campaign_name || `PGMN Campaign - ${budget_php}PHP ${duration_days}d`;

  // Determine objective & optimization based on content type
  // Both use OUTCOME_ENGAGEMENT — videos optimize for THRUPLAY, photos for POST_ENGAGEMENT
  const isReel = content_type === 'reel';
  const objective = 'OUTCOME_ENGAGEMENT';
  const optimizationGoal = isReel ? 'THRUPLAY' : 'POST_ENGAGEMENT';

  // 1. Create campaign
  const campaignParams = {
    name, objective, status: 'ACTIVE',
    special_ad_categories: political ? '["ISSUES_ELECTIONS_POLITICS"]' : '[]',
    is_adset_budget_sharing_enabled: 'false'
  };
  if (political) {
    const targetC = countries && countries.length ? countries : ['PH'];
    campaignParams.special_ad_category_country = JSON.stringify(targetC);
  }
  const campaign = await metaPost(`${AD_ACCOUNT_ID}/campaigns`, campaignParams);
  if (campaign.error) return campaign;

  const now = new Date();
  const end = new Date(now.getTime() + duration_days * 86400000);
  const fmt = d => d.toISOString().replace(/\.\d+Z$/, '+0800');

  const targetCountries = countries && countries.length ? countries : ['PH'];
  // Build geo_locations — if PH cities are specified, use cities for PH instead of country
  const geoLocations = {};
  if (cities && cities.length > 0) {
    // Use city-level targeting for PH (cannot mix countries + cities in same country)
    geoLocations.cities = cities;
    // Add non-PH countries if any
    const otherCountries = targetCountries.filter(c => c !== 'PH');
    if (otherCountries.length > 0) geoLocations.countries = otherCountries;
  } else {
    geoLocations.countries = targetCountries;
  }
  const targeting = { geo_locations: geoLocations, age_min: 18, age_max: 65 };
  if (platform === 'facebook_only') targeting.publisher_platforms = ['facebook'];
  else if (platform === 'instagram_only') targeting.publisher_platforms = ['instagram'];
  else targeting.publisher_platforms = ['facebook', 'instagram'];

  const results = { campaign_id: campaign.id, adsets: [], ads: [], objective, optimization_goal: optimizationGoal };
  const storyId = object_story_id || (page_id && post_id ? `${page_id}_${post_id}` : null);

  // Pre-fetch IG actor if needed (so we fail fast before creating adsets)
  let igActorId = null;
  let igActorSource = null;
  if (use_ig_media && ig_media_id && !creative_id) {
    const igResult = await getIgActorId();
    if (!igResult) {
      return {
        error: 'No Instagram account found for ads. Connect your IG account to your Page in Meta Business Settings > Instagram Accounts.',
        campaign_id: campaign.id,
      };
    }
    igActorId = igResult.id;
    igActorSource = igResult.source;
  }

  const createAdSet = async (adsetName, budgetPhp, extraTargeting = {}) => {
    const t = { ...targeting, ...extraTargeting };
    const adsetParams = {
      campaign_id: campaign.id, name: adsetName,
      lifetime_budget: String(Math.round(budgetPhp * 100)),
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      optimization_goal: optimizationGoal, billing_event: 'IMPRESSIONS',
      destination_type: isReel ? 'UNDEFINED' : 'ON_POST',
      start_time: fmt(now), end_time: fmt(end),
      targeting: JSON.stringify(t), status: 'ACTIVE'
    };
    const adset = await metaPost(`${AD_ACCOUNT_ID}/adsets`, adsetParams);
    if (adset.error) { results.adsets.push({ error: adset.error }); return adset; }
    results.adsets.push(adset);

    // ─── Determine creative to use ───
    let creativeIdToUse = creative_id;

    if (!creativeIdToUse) {
      let creative;
      const creativeParams = { name: `${adsetName} - Creative` };
      if (political) creativeParams.authorization_category = 'POLITICAL';

      if (use_ig_media && ig_media_id && igActorId) {
        // instagram_actor_id deprecated in v22.0; use instagram_user_id + object_id
        creativeParams.instagram_user_id = igActorId;
        creativeParams.source_instagram_media_id = ig_media_id;
        creativeParams.object_id = PAGE_ID;
        creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, creativeParams);
      } else if (storyId) {
        creativeParams.object_story_id = storyId;
        creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, creativeParams);
      }
      if (!creative) {
        results.ads.push({ error: 'No creative_id, ig_media, or object_story_id provided' });
        return adset;
      }
      if (creative.error) {
        // Include debug info
        creative.error._debug = {
          ig_user_id_used: creativeParams.instagram_user_id || null,
          ig_actor_source: igActorSource || 'n/a',
          ig_media_id_used: creativeParams.source_instagram_media_id || null,
          object_story_id_used: creativeParams.object_story_id || null,
        };
        results.ads.push({ error: creative.error });
        return adset;
      }
      creativeIdToUse = creative.id;
    }

    // 3. Create ad using the creative
    const ad = await metaPost(`${AD_ACCOUNT_ID}/ads`, {
      name: `${adsetName} - Ad`, adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creativeIdToUse }), status: 'ACTIVE'
    });
    if (ad.error) { results.ads.push({ error: ad.error }); } else { results.ads.push(ad); }
    return adset;
  };

  if (ab_test) {
    await createAdSet(`${name} - Broad`, budget_php / 2);
    await createAdSet(`${name} - Core 25-44`, budget_php / 2, { age_min: 25, age_max: 44 });
  } else {
    await createAdSet(`${name} - Main`, budget_php);
  }

  // Check for failures
  const adErrors = results.ads.filter(a => a.error);
  const adsetErrors = results.adsets.filter(a => a.error);

  const describeError = (e) => {
    if (typeof e === 'object') {
      const parts = [e.message || 'Unknown error'];
      if (e.error_user_msg) parts.push(e.error_user_msg);
      else if (e.error_user_title) parts.push(e.error_user_title);
      if (e.error_subcode) parts.push(`(subcode: ${e.error_subcode})`);
      if (e._debug) parts.push(`[ig_user: ${e._debug.ig_user_id_used} (${e._debug.ig_actor_source}), media: ${e._debug.ig_media_id_used}]`);
      return parts.join(' — ');
    }
    return String(e);
  };

  if (adErrors.length > 0 || results.ads.length === 0) {
    const errorDetails = adErrors.map(a => describeError(a.error));
    return { error: `Campaign created but ad creation failed: ${errorDetails.join('; ')}`, data: results };
  }

  if (adsetErrors.length > 0) {
    const errorDetails = adsetErrors.map(a => describeError(a.error));
    return { error: `Campaign created but ad set creation failed: ${errorDetails.join('; ')}`, data: results };
  }

  return results;
}

async function getPagePosts() {
  const cached = getCached('posts');
  if (cached) return cached;

  // Pull promoted posts from ad creatives (ad account token has permission)
  const creatives = await metaGet(`${AD_ACCOUNT_ID}/adcreatives`, {
    fields: 'id,name,object_story_id,thumbnail_url,title,body,instagram_permalink_url',
    limit: '30'
  });

  if (creatives.error) {
    return { data: [], error: creatives.error };
  }

  // Deduplicate by post_id, split by platform
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
  setCache('posts', result);
  return result;
}

async function updateCampaignStatus(campaignId, action) {
  const statusMap = { pause: 'PAUSED', activate: 'ACTIVE', archive: 'ARCHIVED' };
  return metaPost(campaignId, { status: statusMap[action] || action });
}

// ─── HTTP Server ───

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Serve frontend
  if (pathname === '/' || pathname === '/app') {
    const filePath = path.join(__dirname, 'frontend', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // API routes
  try {
    if (pathname === '/api/campaigns' && req.method === 'GET') {
      return sendJSON(res, await getCampaigns());
    }
    if (pathname === '/api/campaigns/active' && req.method === 'GET') {
      return sendJSON(res, await getActiveCampaigns());
    }
    if (pathname.match(/^\/api\/campaigns\/\d+\/insights$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      return sendJSON(res, await getCampaignInsights(id));
    }
    if (pathname === '/api/stats' && req.method === 'GET') {
      return sendJSON(res, await getStats());
    }
    if (pathname === '/api/launch' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await launchCampaign(body);
      if (result.error) {
        return sendJSON(res, { status: 'partial_failure', error: result.error, data: result.data }, 400);
      }
      return sendJSON(res, { status: 'created', data: result });
    }
    if (pathname === '/api/geo-search' && req.method === 'GET') {
      const q = parsed.query?.q || '';
      if (q.length < 2) return sendJSON(res, { error: 'Query must be at least 2 characters' }, 400);
      const result = await metaGet('search', {
        type: 'adgeolocation',
        location_types: '["city","region"]',
        q,
        country_code: 'PH',
        limit: '10',
      });
      if (result.error) return sendJSON(res, { error: result.error }, 400);
      const data = (result.data || []).map(r => ({
        key: r.key, name: r.name, type: r.type,
        region: r.region || '', country_code: r.country_code,
      }));
      return sendJSON(res, { data });
    }
    if (pathname === '/api/resolve-post' && req.method === 'GET') {
      const postUrl = parsed.query?.url;
      if (!postUrl) return sendJSON(res, { error: 'url parameter required' }, 400);
      return sendJSON(res, await resolvePost(postUrl));
    }
    if (pathname === '/api/posts' && req.method === 'GET') {
      if (parsed.query?.nocache === '1') delete cache['posts'];
      return sendJSON(res, await getPagePosts());
    }
    if (pathname === '/api/campaigns/status' && req.method === 'POST') {
      const body = await parseBody(req);
      return sendJSON(res, await updateCampaignStatus(body.campaign_id, body.action));
    }

    sendJSON(res, { error: 'Not found' }, 404);
  } catch (err) {
    sendJSON(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`PGMN Ad Launcher running at http://localhost:${PORT}`);
});
