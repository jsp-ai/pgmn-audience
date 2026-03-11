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

// ─── API Route Handlers ───

async function getCampaigns(limit = 30) {
  return metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
    fields: 'name,status,objective,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining',
    limit: String(limit)
  });
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
  const fields = [
    'campaign_name', 'campaign_id', 'spend', 'impressions', 'reach',
    'actions', 'cost_per_action_type', 'cpm', 'ctr', 'clicks'
  ].join(',');
  const result = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
    fields, date_preset: 'last_7d', level: 'campaign', limit: '50'
  });
  const campaigns = (result.data || []).map(calculateMetrics);
  campaigns.sort((a, b) => b.eng_per_peso - a.eng_per_peso);
  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalEng = campaigns.reduce((s, c) => s + c.engagements, 0);
  return {
    total_spend: totalSpend,
    total_engagements: totalEng,
    overall_eng_per_peso: totalSpend > 0 ? Math.round(totalEng / totalSpend * 100) / 100 : 0,
    campaign_count: campaigns.length,
    top_performers: campaigns.slice(0, 5),
    worst_performers: campaigns.slice(-3)
  };
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

async function launchCampaign(body) {
  const { content_url, budget_php, duration_days, page_id, post_id, campaign_name, platform, ab_test } = body;
  const name = campaign_name || `PGMN Burst - ${budget_php}PHP ${duration_days}d`;

  // 1. Create campaign
  const campaign = await metaPost(`${AD_ACCOUNT_ID}/campaigns`, {
    name, objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED',
    special_ad_categories: '[]'
  });
  if (campaign.error) return campaign;

  const now = new Date();
  const end = new Date(now.getTime() + duration_days * 86400000);
  const fmt = d => d.toISOString().replace(/\.\d+Z$/, '+0800');

  const targeting = { geo_locations: { countries: ['PH'] }, age_min: 18, age_max: 65 };
  if (platform === 'facebook_only') targeting.publisher_platforms = ['facebook'];
  else if (platform === 'instagram_only') targeting.publisher_platforms = ['instagram'];
  else targeting.publisher_platforms = ['facebook', 'instagram'];

  const results = { campaign_id: campaign.id, adsets: [], ads: [] };

  const createAdSet = async (adsetName, budgetPhp, extraTargeting = {}) => {
    const t = { ...targeting, ...extraTargeting };
    const adset = await metaPost(`${AD_ACCOUNT_ID}/adsets`, {
      campaign_id: campaign.id, name: adsetName,
      lifetime_budget: String(Math.round(budgetPhp * 100)),
      optimization_goal: 'POST_ENGAGEMENT', billing_event: 'IMPRESSIONS',
      start_time: fmt(now), end_time: fmt(end),
      targeting: JSON.stringify(t), status: 'PAUSED'
    });
    results.adsets.push(adset);
    // Create ad
    if (post_id) {
      const creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, {
        name: `${adsetName} - Creative`, object_story_id: `${page_id}_${post_id}`
      });
      const ad = await metaPost(`${AD_ACCOUNT_ID}/ads`, {
        name: `${adsetName} - Ad`, adset_id: adset.id,
        creative: JSON.stringify({ creative_id: creative.id }), status: 'PAUSED'
      });
      results.ads.push(ad);
    }
    return adset;
  };

  if (ab_test) {
    await createAdSet(`${name} - Broad`, budget_php / 2);
    await createAdSet(`${name} - Core 25-44`, budget_php / 2, { age_min: 25, age_max: 44 });
  } else {
    await createAdSet(`${name} - Main`, budget_php);
  }

  return results;
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
      return sendJSON(res, { status: 'created', data: await launchCampaign(body) });
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
