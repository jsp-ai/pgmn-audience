const { metaGet, calculateMetrics, AD_ACCOUNT_ID } = require('../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Get active campaign count
    const active = await metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
      fields: 'id',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: '100'
    });
    const activeCount = (active.data || []).length;

    // Get daily spend (today)
    const todayInsights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
      fields: 'spend',
      date_preset: 'today'
    });
    const todaySpend = todayInsights.data && todayInsights.data[0]
      ? parseFloat(todayInsights.data[0].spend || 0)
      : 0;

    // Get monthly spend (this month)
    const monthInsights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
      fields: 'spend',
      date_preset: 'this_month'
    });
    const monthSpend = monthInsights.data && monthInsights.data[0]
      ? parseFloat(monthInsights.data[0].spend || 0)
      : 0;

    res.status(200).json({
      active_count: activeCount,
      total_daily_spend: Math.round(todaySpend * 100) / 100,
      total_monthly_spend: Math.round(monthSpend * 100) / 100
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
