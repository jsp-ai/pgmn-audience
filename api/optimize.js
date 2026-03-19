const Anthropic = require('@anthropic-ai/sdk');
const { metaGet, metaPost, calculateMetrics, AD_ACCOUNT_ID } = require('../lib/meta');
const { googleAdsQuery, isGoogleAdsConfigured, formatDateForGoogle } = require('../lib/google');

// Historical benchmarks — TARGETS are 50% above these (the goal)
const BENCHMARKS = {
  reel: { eng_per_peso: 38.5, views_per_peso: 25.0 },
  trailer: { eng_per_peso: 33.1, views_per_peso: 20.0 },
  full_episode: { eng_per_peso: 32.9, views_per_peso: 18.0 },
  podcast: { eng_per_peso: 28.0, views_per_peso: 15.0 },
  carousel: { eng_per_peso: 2.9, views_per_peso: 0 },
  article: { eng_per_peso: 4.6, views_per_peso: 0 },
  default: { eng_per_peso: 15.0, views_per_peso: 10.0 },
};

function classifyContent(name) {
  const n = name.toLowerCase();
  if (n.includes('reel')) return 'reel';
  if (n.includes('trailer') || n.includes('teaser')) return 'trailer';
  if (n.includes('full ep')) return 'full_episode';
  if (n.includes('podcast')) return 'podcast';
  if (n.includes('carousel')) return 'carousel';
  if (n.includes('article') || n.includes('card')) return 'article';
  return 'default';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dryRun = req.query.dry_run !== 'false';

  try {
    // 1. Get active campaigns
    const active = await metaGet(`${AD_ACCOUNT_ID}/campaigns`, {
      fields: 'name,status,objective,start_time,stop_time',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: '50'
    });

    const campaigns = active.data || [];
    if (!campaigns.length) {
      return res.status(200).json({
        campaigns: [],
        ai_analysis: { summary: 'No active campaigns found.', recommendations: [] }
      });
    }

    // 2. Get insights for each active campaign (with follow/reaction metrics)
    const insightFields = [
      'campaign_name', 'campaign_id', 'spend', 'impressions', 'reach',
      'actions', 'cost_per_action_type', 'cpm', 'ctr', 'clicks'
    ].join(',');

    const campaignData = [];
    const debugErrors = [];
    for (const camp of campaigns) {
      try {
        const result = await metaGet(`${camp.id}/insights`, {
          fields: insightFields, date_preset: 'maximum'
        });
        if (result.error) {
          debugErrors.push({ campaign: camp.name, error: result.error.message || result.error });
          continue;
        }
        if (result.data && result.data[0]) {
          const metrics = calculateMetrics(result.data[0]);
          const contentType = classifyContent(metrics.campaign_name || '');
          const benchmark = BENCHMARKS[contentType] || BENCHMARKS.default;
          metrics.platform = 'meta';
          metrics.content_type = contentType;
          metrics.benchmark_eng_per_peso = benchmark.eng_per_peso;
          metrics.target_eng_per_peso = Math.round(benchmark.eng_per_peso * 1.5 * 10) / 10; // 50% above
          metrics.performance_vs_benchmark = benchmark.eng_per_peso > 0
            ? Math.round(metrics.eng_per_peso / benchmark.eng_per_peso * 1000) / 10
            : 0;
          metrics.performance_vs_target = benchmark.eng_per_peso > 0
            ? Math.round(metrics.eng_per_peso / (benchmark.eng_per_peso * 1.5) * 1000) / 10
            : 0;
          metrics.start_time = camp.start_time;
          metrics.stop_time = camp.stop_time;
          metrics.objective = camp.objective;

          // Get adset budget info for this campaign
          try {
            const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
              fields: 'id,lifetime_budget,daily_budget,end_time',
              filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [camp.id] }]),
              limit: '10'
            });
            const adsetList = adsets.data || [];
            metrics.total_budget = adsetList.reduce((sum, as) =>
              sum + (parseInt(as.lifetime_budget || as.daily_budget || '0') / 100), 0);
            metrics.adset_count = adsetList.length;
            if (adsetList[0]?.end_time) metrics.end_time = adsetList[0].end_time;
          } catch (e) { /* skip budget lookup */ }

          campaignData.push(metrics);
        }
      } catch (e) {
        continue;
      }
    }

    // 2b. Add Google Ads campaigns (if configured)
    if (isGoogleAdsConfigured()) {
      try {
        const today = formatDateForGoogle(new Date());
        const gResult = await googleAdsQuery(
          `SELECT campaign.id, campaign.name, campaign.status, campaign.start_date, campaign.end_date, ` +
          `campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.video_views ` +
          `FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.end_date >= '${today}' LIMIT 50`
        );
        if (Array.isArray(gResult)) {
          for (const batch of gResult) {
            for (const row of (batch.results || [])) {
              const c = row.campaign || {};
              const budget = row.campaignBudget || {};
              const m = row.metrics || {};
              const budgetPhp = parseInt(budget.amountMicros || '0') / 1000000;
              const spentPhp = parseInt(m.costMicros || '0') / 1000000;
              const impressions = parseInt(m.impressions || '0');
              const clicks = parseInt(m.clicks || '0');
              const videoViews = parseInt(m.videoViews || '0');
              campaignData.push({
                campaign_id: c.id,
                campaign_name: c.name || `Google Campaign ${c.id}`,
                platform: 'google_ads',
                spend: spentPhp,
                total_budget: budgetPhp,
                impressions,
                reach: 0,
                clicks,
                video_views: videoViews,
                follows: 0,
                reactions: 0,
                engagements: clicks, // Use clicks as proxy for engagement on Google
                ctr: impressions > 0 ? (clicks / impressions * 100).toFixed(2) + '%' : '0%',
                cost_per_click: clicks > 0 ? Math.round(spentPhp / clicks * 100) / 100 : 0,
                views_per_peso: spentPhp > 0 ? Math.round(videoViews / spentPhp * 100) / 100 : 0,
                eng_per_peso: 0,
                content_type: 'youtube_video',
                benchmark_eng_per_peso: null,
                target_eng_per_peso: null,
                performance_vs_benchmark: null,
                performance_vs_target: null,
                start_time: c.startDate || null,
                stop_time: c.endDate || null,
              });
            }
          }
        }
      } catch (e) { /* Google Ads query failed, continue with Meta-only */ }
    }

    // Filter: only analyze campaigns with actual spend (> 0 PHP)
    const activeCampaigns = campaignData.filter(c => c.spend > 0);
    const zeroCampaigns = campaignData.filter(c => c.spend === 0);

    if (!activeCampaigns.length) {
      return res.status(200).json({
        campaigns: campaignData,
        meta_campaigns_found: campaigns.length,
        debug_errors: debugErrors,
        ai_analysis: { summary: 'Active campaigns found but no spend data yet.', recommendations: [] }
      });
    }

    // 3. Send to Claude for analysis (only campaigns with spend)
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are PGMN's campaign optimizer. Your philosophy: EVERY piece of content deserves visibility. PGMN is a media network — establishing relevance on ALL content matters, not just chasing top performers. You NEVER pause or kill campaigns.

Your mission: achieve 50% better overall performance than historical benchmarks by optimizing the PORTFOLIO — scaling winners, extending everything decent, and A/B testing to find better audiences for ALL content.

PGMN is a Philippine media/news network. Budget is 200,000 PHP/month.

CORE PHILOSOPHY:
- Every post gets a BASELINE spend — even low performers build brand relevance, page authority, and content credibility
- Winners get MORE budget on top of the baseline — pour fuel on fire
- Underperformers don't get killed — they get A/B tested to find a better audience
- Extend everything that's had enough time to learn — longer campaigns always outperform short ones
- The goal is portfolio-level performance: total engagements + views + follows across ALL content, not just per-campaign efficiency

HISTORICAL BENCHMARKS → TARGET (50% above):
- Reels: 38.5 → 57.8 eng/PHP
- Trailers: 33.1 → 49.7 eng/PHP
- Full Episodes: 32.9 → 49.4 eng/PHP
- Podcasts: 28.0 → 42.0 eng/PHP
- Articles: 4.6 → 6.9 eng/PHP
- Carousels: 2.9 → 4.4 eng/PHP

KEY PERFORMANCE DRIVERS:
- 3-day campaigns outperform 1-day by 2.7x (algorithm needs learning time)
- Instagram is 2x more efficient than Facebook
- Budget sweet spot: 3K-5K PHP per campaign
- Higher budgets (5K+) get better algorithm optimization
- Video content massively outperforms static

METRICS (in priority order):
1. eng_per_peso — engagements per peso (primary efficiency KPI)
2. views_per_peso — video views per peso
3. follows — page follows/likes generated
4. virality — (shares + comments) / engagements
5. reach — unique people reached per peso
6. reactions — post reactions (likes, hearts, etc.)

For Google Ads: CTR (target > 3%), cost_per_click (target < 4 PHP), video_views

ACTIVE CAMPAIGNS (${activeCampaigns.length} with spend, ${zeroCampaigns.length} still learning/no spend):
${JSON.stringify(activeCampaigns, null, 2)}

For each campaign, recommend ONE action (NEVER pause/kill):

- **SCALE**: Top performer — increase budget to amplify. Winners fund the portfolio.
  Specify new_budget (PHP). Max increase = 50% of current or ₱3,000 (whichever smaller). Total ≤ ₱10,000.

- **EXTEND**: Performing decently, give it more runway. More time = more algorithm learning = better delivery.
  Specify new_end_date (YYYY-MM-DD). Add 3-5 more days. Every campaign should aim for at least 3 days total.

- **AB_TEST**: Not hitting targets yet — don't give up on it, find a better audience.
  Specify ab_test_type: "age" (25-34 vs 35-44), "geo" (PH-only vs multi), or "platform" (IG-only vs FB+IG).
  This is especially important for content that's strategically valuable but underperforming — find the right audience, don't abandon it.

- **MAINTAIN**: Campaign is young (< 24h) or already at target and well-funded. Check back tomorrow.

DECISION FRAMEWORK:
- performance_vs_target > 100% → SCALE (beating target, pour fuel)
- performance_vs_target 60-100% → EXTEND (on track, give more time to compound)
- performance_vs_target < 60% AND campaign > 48h → AB_TEST (find better audience, don't abandon)
- Campaign < 24h old → MAINTAIN (too early)
- Campaign ending within 48h AND any positive performance → EXTEND (keep it alive)
- Low performer with high virality (shares+comments) → SCALE (viral potential despite low raw numbers)

PORTFOLIO THINKING:
- Calculate total engagements, views, and follows across ALL campaigns
- Compare to what the same total spend would have achieved at historical benchmarks
- Identify which campaigns are "carrying" the portfolio and which need audience adjustments
- The 50% improvement target is on the TOTAL portfolio, not each individual campaign

IMPORTANT: Keep all text fields concise (reason < 80 chars, projected_improvement < 60 chars). Return JSON only, no markdown:
{
  "recommendations": [
    {
      "campaign_id": "...",
      "campaign_name": "...",
      "platform": "meta|google_ads",
      "action": "SCALE|EXTEND|AB_TEST|MAINTAIN",
      "reason": "...",
      "new_budget": null,
      "new_end_date": null,
      "ab_test_type": null,
      "current_performance": "X% of target",
      "projected_improvement": "what this action should achieve"
    }
  ],
  "portfolio_score": {
    "total_spend": 0,
    "total_engagements": 0,
    "total_views": 0,
    "total_follows": 0,
    "overall_eng_per_peso": 0,
    "vs_historical": "X% of historical benchmark",
    "vs_target": "X% of 50% improvement target"
  },
  "budget_strategy": "how to distribute remaining monthly budget across content types",
  "content_advice": "what content types to create more of, and which need better audiences",
  "performance_gap": "specific actions needed to close the gap to 50% improvement",
  "summary": "one-line portfolio performance summary"
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }]
    });

    let aiAnalysis;
    try {
      const text = response.content[0].text;
      // Extract JSON: find the outermost { ... } regardless of code fences
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      const cleaned = (firstBrace !== -1 && lastBrace > firstBrace)
        ? text.substring(firstBrace, lastBrace + 1)
        : text.trim();
      aiAnalysis = JSON.parse(cleaned);
    } catch (e) {
      aiAnalysis = {
        raw_response: response.content[0].text,
        recommendations: [],
        summary: 'AI analysis complete (see raw response)'
      };
    }

    // 4. Execute actions if not dry run
    const actionsTaken = [];
    if (!dryRun) {
      for (const rec of (aiAnalysis.recommendations || [])) {
        if (!rec.campaign_id) continue;
        const platform = rec.platform || 'meta';

        try {
          if (rec.action === 'SCALE' && rec.new_budget) {
            if (platform === 'meta') {
              const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
                fields: 'id,lifetime_budget',
                filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [rec.campaign_id] }]),
                limit: '50'
              });
              const adsetList = adsets.data || [];
              const currentTotal = adsetList.reduce((sum, as) => sum + (parseInt(as.lifetime_budget || '0') / 100), 0);
              for (const as of adsetList) {
                const currentBudget = parseInt(as.lifetime_budget || '0') / 100;
                const ratio = currentTotal > 0 ? currentBudget / currentTotal : 1 / adsetList.length;
                const newBudget = Math.round(rec.new_budget * ratio * 100);
                await metaPost(as.id, { lifetime_budget: String(newBudget) });
              }
            } else {
              const { googleAdsQuery: gQuery, googleAdsMutate: gMutate } = require('../lib/google');
              const budgetQ = await gQuery(
                `SELECT campaign_budget.resource_name FROM campaign_budget WHERE campaign.id = ${rec.campaign_id}`
              );
              let budgetRes = null;
              if (Array.isArray(budgetQ)) {
                for (const batch of budgetQ) {
                  for (const row of (batch.results || [])) budgetRes = row.campaignBudget?.resourceName;
                }
              }
              if (budgetRes) {
                await gMutate([{
                  campaignBudgetOperation: {
                    update: { resourceName: budgetRes, amountMicros: String(Math.round(rec.new_budget * 1000000)) },
                    updateMask: 'amount_micros',
                  }
                }]);
              }
            }
            actionsTaken.push({ action: 'SCALE', campaign: rec.campaign_name, platform, new_budget: rec.new_budget });

          } else if (rec.action === 'EXTEND' && rec.new_end_date) {
            if (platform === 'meta') {
              const newEndTime = new Date(rec.new_end_date + 'T23:59:59+0800').toISOString();
              const adsets = await metaGet(`${AD_ACCOUNT_ID}/adsets`, {
                fields: 'id,end_time',
                filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [rec.campaign_id] }]),
                limit: '50'
              });
              for (const as of (adsets.data || [])) {
                await metaPost(as.id, { end_time: newEndTime });
              }
            } else {
              const { googleAdsMutate: gMutate, GOOGLE_ADS_CUSTOMER_ID: custId } = require('../lib/google');
              await gMutate([{
                campaignOperation: {
                  update: {
                    resourceName: `customers/${custId}/campaigns/${rec.campaign_id}`,
                    endDate: rec.new_end_date,
                  },
                  updateMask: 'end_date',
                }
              }]);
            }
            actionsTaken.push({ action: 'EXTEND', campaign: rec.campaign_name, platform, new_end_date: rec.new_end_date });

          } else if (rec.action === 'AB_TEST') {
            // A/B tests are logged as recommendations — execution requires creating a new campaign
            // via the launch endpoint, which needs the original post details. Flag for manual follow-up.
            actionsTaken.push({
              action: 'AB_TEST',
              campaign: rec.campaign_name,
              platform,
              ab_test_type: rec.ab_test_type,
              note: 'A/B test recommended — re-launch this post through the Ad Launcher with A/B test enabled',
            });

          } else if (rec.action === 'MAINTAIN') {
            actionsTaken.push({ action: 'MAINTAIN', campaign: rec.campaign_name, platform });
          }
        } catch (e) {
          actionsTaken.push({ action: rec.action, campaign: rec.campaign_name, platform, error: e.message });
        }
      }
    }

    res.status(200).json({
      campaigns: campaignData,
      ai_analysis: aiAnalysis,
      actions_taken: actionsTaken,
      dry_run: dryRun,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
