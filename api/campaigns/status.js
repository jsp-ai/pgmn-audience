const { metaPost } = require('../../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { campaign_id, action } = req.body;
    const statusMap = { pause: 'PAUSED', activate: 'ACTIVE', archive: 'ARCHIVED' };
    const data = await metaPost(campaign_id, { status: statusMap[action] || action });
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
