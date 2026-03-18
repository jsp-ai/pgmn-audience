const https = require('https');
const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET } = require('../lib/google');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html');

  const code = req.query.code;
  const error = req.query.error;

  if (error) {
    return res.status(400).end(`
      <html><body style="font-family:monospace;padding:40px;background:#162831;color:#fff">
        <h2 style="color:#FB041C">OAuth Error</h2>
        <p>${error}</p>
        <a href="/" style="color:#FB041C">Back to Ad Launcher</a>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).end(`
      <html><body style="font-family:monospace;padding:40px;background:#162831;color:#fff">
        <h2 style="color:#FB041C">Missing authorization code</h2>
        <a href="/api/google-oauth" style="color:#FB041C">Try again</a>
      </body></html>
    `);
  }

  try {
    // Exchange authorization code for tokens
    const host = req.headers.host || 'localhost:3000';
    const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
    const protocol = req.headers['x-forwarded-proto'] || (isLocalhost ? 'http' : 'https');
    const redirectUri = `${protocol}://${host}/api/google-oauth-callback`;

    const tokenData = await new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        code,
        client_id: GOOGLE_ADS_CLIENT_ID,
        client_secret: GOOGLE_ADS_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
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
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid token response')); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    if (tokenData.error) {
      return res.status(400).end(`
        <html><body style="font-family:monospace;padding:40px;background:#162831;color:#fff">
          <h2 style="color:#FB041C">Token Exchange Error</h2>
          <p>${tokenData.error_description || tokenData.error}</p>
          <a href="/api/google-oauth" style="color:#FB041C">Try again</a>
        </body></html>
      `);
    }

    const refreshToken = tokenData.refresh_token || '(no refresh token — try revoking access and re-authorizing)';

    return res.status(200).end(`
      <html><body style="font-family:monospace;padding:40px;background:#162831;color:#fff;max-width:700px">
        <h2 style="color:#FB041C">Google Ads OAuth Complete</h2>
        <p style="color:#aaa">Copy the refresh token below and add it to your Vercel environment variables as <strong>GOOGLE_ADS_REFRESH_TOKEN</strong>.</p>

        <div style="background:#0d1b22;border:1px solid #333;border-radius:8px;padding:20px;margin:20px 0">
          <label style="color:#aaa;font-size:12px;text-transform:uppercase">Refresh Token</label>
          <input id="token" value="${refreshToken}" readonly
            style="width:100%;padding:12px;background:#1a2a33;border:1px solid #444;color:#fff;border-radius:4px;font-size:14px;margin-top:8px"
            onclick="this.select()">
          <button onclick="navigator.clipboard.writeText(document.getElementById('token').value);this.textContent='Copied!'"
            style="margin-top:12px;padding:10px 24px;background:#FB041C;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold">
            Copy Token
          </button>
        </div>

        <p style="color:#666;font-size:12px">This token does not expire unless you revoke access. Store it securely.</p>
        <a href="/" style="color:#FB041C">Back to Ad Launcher</a>
      </body></html>
    `);

  } catch (err) {
    return res.status(500).end(`
      <html><body style="font-family:monospace;padding:40px;background:#162831;color:#fff">
        <h2 style="color:#FB041C">Error</h2>
        <p>${err.message}</p>
        <a href="/api/google-oauth" style="color:#FB041C">Try again</a>
      </body></html>
    `);
  }
};
