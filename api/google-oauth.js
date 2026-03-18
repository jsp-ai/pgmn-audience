const { GOOGLE_ADS_CLIENT_ID } = require('../lib/google');

module.exports = async (req, res) => {
  if (!GOOGLE_ADS_CLIENT_ID) {
    return res.status(500).json({ error: 'GOOGLE_ADS_CLIENT_ID not configured' });
  }

  // Determine redirect URI based on the request host
  const host = req.headers.host || 'localhost:3000';
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = req.headers['x-forwarded-proto'] || (isLocalhost ? 'http' : 'https');
  const redirectUri = `${protocol}://${host}/api/google-oauth-callback`;

  const params = new URLSearchParams({
    client_id: GOOGLE_ADS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent', // Force consent to get a refresh token
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.writeHead(302, { Location: authUrl });
  res.end();
};
