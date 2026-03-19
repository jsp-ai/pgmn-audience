const { metaGet, metaPost, AD_ACCOUNT_ID } = require('../lib/meta');
const { googleAdsQuery, isGoogleAdsConfigured, formatDateForGoogle } = require('../lib/google');

// Simple in-memory cache (persists across warm Vercel invocations)
let campaignCache = { data: null, ts: 0 };
const CACHE_TTL = 120000; // 2 minutes

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST: update campaign status (pause/activate/archive)
  if (req.method === 'POST') {
    try {
      const { campaign_id, action } = req.body;
      const statusMap = { pause: 'PAUSED', activate: 'ACTIVE', archive: 'ARCHIVED' };
      const data = await metaPost(campaign_id, { status: statusMap[action] || action });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // GET: list campaigns with enriched data
  // Return cached if fresh
  if (campaignCache.data && Date.now() - campaignCache.ts < CACHE_TTL) {
    return res.status(200).json(campaignCache.data);
  }

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

    // 2. Get adset budgets (summed per campaign, graceful on rate limit)
    const budgetMap = {};
    try {
      const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
        fields: 'campaign_id,lifetime_budget,daily_budget',
        filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campIds }]),
        limit: '200'
      });
      for (const as of (adsets.data || [])) {
        const cid = as.campaign_id;
        if (!budgetMap[cid]) budgetMap[cid] = 0;
        if (as.lifetime_budget) budgetMap[cid] += parseInt(as.lifetime_budget) / 100;
        else if (as.daily_budget) budgetMap[cid] += parseInt(as.daily_budget) / 100;
      }
    } catch (e) { /* adset budget lookup failed, continue without */ }

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

    // --- Google Ads campaigns (if configured) ---
    if (isGoogleAdsConfigured()) {
      try {
        const today = formatDateForGoogle(new Date());
        const gResult = await googleAdsQuery(
          `SELECT campaign.id, campaign.name, campaign.status, campaign.start_date, campaign.end_date, ` +
          `campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks ` +
          `FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.start_date DESC LIMIT 30`
        );

        if (Array.isArray(gResult)) {
          for (const batch of gResult) {
            for (const row of (batch.results || [])) {
              const c = row.campaign || {};
              const budget = row.campaignBudget || {};
              const m = row.metrics || {};
              const budgetPhp = parseInt(budget.amountMicros || '0') / 1000000;
              const spentPhp = parseInt(m.costMicros || '0') / 1000000;

              // Apply same filtering as Meta
              if (c.endDate && c.endDate < today) continue;
              if (budgetPhp > 0 && spentPhp >= budgetPhp) continue;

              enriched.push({
                id: c.id,
                name: c.name,
                status: c.status === 'ENABLED' ? 'ACTIVE' : c.status === 'PAUSED' ? 'PAUSED' : c.status,
                objective: 'DEMAND_GEN',
                start_time: c.startDate || null,
                stop_time: c.endDate || null,
                platform: 'google_ads',
                total_budget: budgetPhp || null,
                insights: {
                  spend: spentPhp,
                  impressions: parseInt(m.impressions || '0'),
                  reach: 0,
                  clicks: parseInt(m.clicks || '0'),
                  engagements: 0,
                  video_views: 0,
                  eng_per_peso: 0,
                },
              });
            }
          }
        }
      } catch (e) { /* Google Ads query failed, continue with Meta-only */ }
    }

    const result = { data: enriched, paging: campaigns.paging };
    campaignCache = { data: result, ts: Date.now() };
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
