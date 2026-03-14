const { metaGet } = require('../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query.q || '';
    if (q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    // Search Meta's ad geo-location database for PH cities & regions
    const result = await metaGet('search', {
      type: 'adgeolocation',
      location_types: '["city","region"]',
      q,
      country_code: 'PH',
      limit: '10',
    });

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Return simplified results
    const data = (result.data || []).map(r => ({
      key: r.key,
      name: r.name,
      type: r.type,
      region: r.region || '',
      country_code: r.country_code,
    }));

    res.status(200).json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
