const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { short_token } = req.body;
    if (!short_token) {
      return res.status(400).json({ error: 'short_token is required' });
    }

    const APP_ID = process.env.META_APP_ID;
    const APP_SECRET = process.env.META_APP_SECRET;
    if (!APP_ID || !APP_SECRET) {
      return res.status(500).json({ error: 'META_APP_ID and META_APP_SECRET must be set in environment variables' });
    }

    const API_VERSION = process.env.META_API_VERSION || 'v25.0';

    // Exchange short-lived token for long-lived token (60 days)
    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: short_token,
    });

    const result = await new Promise((resolve) => {
      const url = `https://graph.facebook.com/${API_VERSION}/oauth/access_token?${params.toString()}`;
      https.get(url, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ error: 'Invalid response from Meta' }); }
        });
      }).on('error', () => resolve({ error: 'Network error' }));
    });

    if (result.error) {
      return res.status(400).json({
        error: result.error.message || result.error,
        type: result.error.type,
      });
    }

    // Calculate expiry date
    const expiresIn = result.expires_in || 5184000; // default 60 days
    const expiryDate = new Date(Date.now() + expiresIn * 1000);

    res.status(200).json({
      access_token: result.access_token,
      token_type: result.token_type || 'bearer',
      expires_in_seconds: expiresIn,
      expires_in_days: Math.round(expiresIn / 86400),
      expires_at: expiryDate.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
