const { metaGet, AD_ACCOUNT_ID } = require('../../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Get campaigns
    const campaigns = await metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
      fields: 'name,status,objective,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining',
      limit: '30'
    });

    const campIds = (campaigns.data || []).map(c => c.id);
    if (!campIds.length) {
      return res.status(200).json({ data: [], paging: campaigns.paging });
    }

    // 2. Get adset budgets (summed per campaign)
    const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
      fields: 'campaign_id,lifetime_budget,daily_budget',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
      limit: '200'
    });
    const budgetMap = {};
    for (const as of (adsets.data || [])) {
      const cid = as.campaign_id;
      if (!budgetMap[cid]) budgetMap[cid] = 0;
      if (as.lifetime_budget) budgetMap[cid] += parseInt(as.lifetime_budget) / 100;
      else if (as.daily_budget) budgetMap[cid] += parseInt(as.daily_budget) / 100;
    }

    // 3. Get insights filtered to only these campaign IDs
    const insightFields = [
      'campaign_id', 'campaign_name', 'spend', 'impressions', 'reach',
      'actions', 'clicks'
    ].join(',');
    const insights = await metaGet(`${AD_ACCOUNT_ID}/insights`, {
      fields: insightFields,
      date_preset: 'maximum',
      level: 'campaign',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
      limit: '100'
    });

    // 4. Build insights lookup by campaign_id
    const insightsMap = {};
    for (const row of (insights.data || [])) {
      const spend = parseFloat(row.spend || 0);
      let engagements = 0, videoViews = 0;
      for (const action of (row.actions || [])) {
        if (action.action_type === 'post_engagement') engagements = parseInt(action.value);
        if (action.action_type === 'video_view') videoViews = parseInt(action.value);
      }
      insightsMap[row.campaign_id] = {
        spend,
        impressions: parseInt(row.impressions || 0),
        reach: parseInt(row.reach || 0),
        clicks: parseInt(row.clicks || 0),
        engagements,
        video_views: videoViews,
        eng_per_peso: spend > 0 ? Math.round(engagements / spend * 100) / 100 : 0
      };
    }

    // 5. Merge everything into campaign data
    const now = new Date();
    const enriched = (campaigns.data || []).map(c => {
      let totalBudget = null;
      if (c.lifetime_budget) totalBudget = parseInt(c.lifetime_budget) / 100;
      else if (c.daily_budget) totalBudget = parseInt(c.daily_budget) / 100;
      else if (budgetMap[c.id]) totalBudget = budgetMap[c.id];

      return {
        ...c,
        total_budget: totalBudget,
        insights: insightsMap[c.id] || null
      };
    }).filter(c => {
      // Exclude campaigns past their end date
      if (c.stop_time && new Date(c.stop_time) < now) return false;
      // Exclude campaigns that have spent 100% of budget
      const spent = c.insights ? c.insights.spend : 0;
      if (c.total_budget && spent >= c.total_budget) return false;
      return true;
    });

    res.status(200).json({ data: enriched, paging: campaigns.paging });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
