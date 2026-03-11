const { metaGet, calculateMetrics } = require('../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Campaign ID required' });

    const fields = [
      'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
      'actions', 'cost_per_action_type', 'cpm', 'cpp', 'ctr',
      'clicks', 'unique_clicks'
    ].join(',');
    const result = await metaGet(`${id}/insights`, { fields, date_preset: 'lifetime' });
    if (result.data && result.data[0]) {
      return res.status(200).json(calculateMetrics(result.data[0]));
    }
    res.status(200).json({ message: 'No data available yet' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
