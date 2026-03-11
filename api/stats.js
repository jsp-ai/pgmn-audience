const { metaGet, calculateMetrics, AD_ACCOUNT_ID } = require('../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
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
    res.status(200).json({
      total_spend: totalSpend,
      total_engagements: totalEng,
      overall_eng_per_peso: totalSpend > 0 ? Math.round(totalEng / totalSpend * 100) / 100 : 0,
      campaign_count: campaigns.length,
      top_performers: campaigns.slice(0, 5),
      worst_performers: campaigns.slice(-3)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
