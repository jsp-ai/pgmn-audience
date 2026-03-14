const https = require('https');

const ACCESS_TOKEN = (process.env.META_ACCESS_TOKEN || '').trim().replace(/\\n$/, '');
const AD_ACCOUNT_ID = (process.env.META_AD_ACCOUNT_ID || '').trim();
const API_VERSION = process.env.META_API_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

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

module.exports = { metaGet, metaPost, calculateMetrics, AD_ACCOUNT_ID };
