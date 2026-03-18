const https = require('https');

// Google Ads API credentials
const GOOGLE_ADS_CLIENT_ID = (process.env.GOOGLE_ADS_CLIENT_ID || '').trim();
const GOOGLE_ADS_CLIENT_SECRET = (process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim();
const GOOGLE_ADS_DEVELOPER_TOKEN = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim();
const GOOGLE_ADS_REFRESH_TOKEN = (process.env.GOOGLE_ADS_REFRESH_TOKEN || '').trim();
const GOOGLE_ADS_CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim().replace(/-/g, '');
const GOOGLE_ADS_LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/-/g, '');
const YOUTUBE_DATA_API_KEY = (process.env.YOUTUBE_DATA_API_KEY || '').trim();

// Google Ads API version
const GOOGLE_ADS_API_VERSION = 'v18';
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// Geo target constant IDs for supported countries
const GEO_TARGET_CONSTANTS = {
  PH: '2608',   // Philippines
  US: '2840',   // United States
  SA: '2682',   // Saudi Arabia
  CA: '2124',   // Canada
  AE: '2784',   // United Arab Emirates
};

// --- OAuth2 Token Management ---
let cachedAccessToken = null;
let tokenExpiresAt = 0;

function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: GOOGLE_ADS_CLIENT_ID,
      client_secret: GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`OAuth2 error: ${parsed.error_description || parsed.error}`));
          cachedAccessToken = parsed.access_token;
          tokenExpiresAt = Date.now() + (parsed.expires_in - 60) * 1000; // refresh 60s early
          resolve(cachedAccessToken);
        } catch (e) { reject(new Error('Invalid OAuth2 response')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) return cachedAccessToken;
  return refreshAccessToken();
}

// --- Google Ads API REST calls ---

async function googleAdsPost(endpoint, body) {
  const accessToken = await getAccessToken();
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const url = new URL(`${GOOGLE_ADS_BASE}/${endpoint}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
        ...(GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Google Ads API')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function googleAdsGet(endpoint) {
  const accessToken = await getAccessToken();
  return new Promise((resolve, reject) => {
    const url = new URL(`${GOOGLE_ADS_BASE}/${endpoint}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
        ...(GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
      },
    };

    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Google Ads API')); }
      });
    }).on('error', reject);
  });
}

// Mutate helper — sends a batch of operations to Google Ads
async function googleAdsMutate(operations) {
  return googleAdsPost(`customers/${GOOGLE_ADS_CUSTOMER_ID}/googleAds:mutate`, {
    mutateOperations: operations,
  });
}

// GAQL query helper
async function googleAdsQuery(query) {
  return googleAdsPost(`customers/${GOOGLE_ADS_CUSTOMER_ID}/googleAds:searchStream`, { query });
}

// --- YouTube Data API ---

function youtubeGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    params.key = YOUTUBE_DATA_API_KEY;
    const qs = new URLSearchParams(params).toString();
    const reqUrl = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`;
    https.get(reqUrl, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from YouTube API')); }
      });
    }).on('error', reject);
  });
}

// --- Utility ---

function formatDateForGoogle(date) {
  // Google Ads expects YYYY-MM-DD
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().split('T')[0];
}

function isGoogleAdsConfigured() {
  return !!(GOOGLE_ADS_CLIENT_ID && GOOGLE_ADS_CLIENT_SECRET &&
    GOOGLE_ADS_DEVELOPER_TOKEN && GOOGLE_ADS_REFRESH_TOKEN && GOOGLE_ADS_CUSTOMER_ID);
}

module.exports = {
  googleAdsPost,
  googleAdsGet,
  googleAdsMutate,
  googleAdsQuery,
  youtubeGet,
  getAccessToken,
  formatDateForGoogle,
  isGoogleAdsConfigured,
  GEO_TARGET_CONSTANTS,
  GOOGLE_ADS_CUSTOMER_ID,
  GOOGLE_ADS_CLIENT_ID,
  GOOGLE_ADS_CLIENT_SECRET,
  YOUTUBE_DATA_API_KEY,
};
