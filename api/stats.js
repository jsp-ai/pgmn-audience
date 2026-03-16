const { metaGet, calculateMetrics, AD_ACCOUNT_ID } = require('../lib/meta');

let statsCache = { data: null, ts: 0 };
const CACHE_TTL = 120000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (statsCache.data && Date.now() - statsCache.ts < CACHE_TTL) {
    return res.status(200).json(statsCache.data);
  }

  try {
    // Get active campaigns with stop_time and budget info
    const active = await metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
      fields: 'id,stop_time,daily_budget,lifetime_budget',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: '100'
    });
    const campaigns = active.data || [];
    const campIds = campaigns.map(c => c.id);

    // Get adset budgets, effective_status, and insights to filter out completed/empty campaigns
    let budgetMap = {};
    let spendMap = {};
    let campaignsWithActiveAdsets = new Set();
    if (campIds.length) {
      const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
        fields: 'campaign_id,lifetime_budget,daily_budget,effective_status',
        filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
        limit: '200'
      });
      for (const as of (adsets.data || [])) {
        if (!budgetMap[as.campaign_id]) budgetMap[as.campaign_id] = 0;
        if (as.lifetime_budget) budgetMap[as.campaign_id] += parseInt(as.lifetime_budget) / 100;
        else if (as.daily_budget) budgetMap[as.campaign_id] += parseInt(as.daily_budget) / 100;
        if (as.effective_status === 'ACTIVE') campaignsWithActiveAdsets.add(as.campaign_id);
      }

      const insights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
        fields: 'campaign_id,spend',
        date_preset: 'maximum',
        level: 'campaign',
        filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
        limit: '200'
      });
      for (const row of (insights.data || [])) {
        spendMap[row.campaign_id] = parseFloat(row.spend || 0);
      }
    }

    const now = new Date();
    const activeCount = campaigns.filter(c => {
      if (!campaignsWithActiveAdsets.has(c.id)) return false;
      if (c.stop_time && new Date(c.stop_time) < now) return false;
      let totalBudget = null;
      if (c.lifetime_budget) totalBudget = parseInt(c.lifetime_budget) / 100;
      else if (c.daily_budget) totalBudget = parseInt(c.daily_budget) / 100;
      else if (budgetMap[c.id]) totalBudget = budgetMap[c.id];
      const spent = spendMap[c.id] || 0;
      if (totalBudget && spent >= totalBudget) return false;
      return true;
    }).length;

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

    const result = {
      active_count: activeCount,
      total_daily_spend: Math.round(todaySpend * 100) / 100,
      total_monthly_spend: Math.round(monthSpend * 100) / 100
    };
    statsCache = { data: result, ts: Date.now() };
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
