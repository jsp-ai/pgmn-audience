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

    // 2. Get insights filtered to only these campaign IDs
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

    // 3. Build insights lookup by campaign_id
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

    // 4. Merge insights into campaign data
    const enriched = (campaigns.data || []).map(c => ({
      ...c,
      insights: insightsMap[c.id] || null
    }));

    res.status(200).json({ data: enriched, paging: campaigns.paging });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
