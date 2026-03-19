const Anthropic = require('@anthropic-ai/sdk');
const { metaGet, metaPost, calculateMetrics, AD_ACCOUNT_ID } = require('../lib/meta');
const { googleAdsQuery, isGoogleAdsConfigured, formatDateForGoogle } = require('../lib/google');

const BENCHMARKS = {
  reel: { eng_per_peso: 38.5 },
  trailer: { eng_per_peso: 33.1 },
  full_episode: { eng_per_peso: 32.9 },
  podcast: { eng_per_peso: 28.0 },
  carousel: { eng_per_peso: 2.9 },
  article: { eng_per_peso: 4.6 },
  default: { eng_per_peso: 15.0 },
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

    // 2. Get insights for each active campaign
    const insightFields = [
      'campaign_name', 'campaign_id', 'spend', 'impressions', 'reach',
      'actions', 'cost_per_action_type', 'cpm', 'ctr', 'clicks'
    ].join(',');

    const campaignData = [];
    for (const camp of campaigns) {
      try {
        const result = await metaGet(`${camp.id}/insights`, {
          fields: insightFields, date_preset: 'lifetime'
        });
        if (result.data && result.data[0]) {
          const metrics = calculateMetrics(result.data[0]);
          const contentType = classifyContent(metrics.campaign_name || '');
          const benchmark = BENCHMARKS[contentType] || BENCHMARKS.default;
          metrics.content_type = contentType;
          metrics.benchmark_eng_per_peso = benchmark.eng_per_peso;
          metrics.performance_vs_benchmark = benchmark.eng_per_peso > 0
            ? Math.round(metrics.eng_per_peso / benchmark.eng_per_peso * 1000) / 10
            : 0;
          metrics.start_time = camp.start_time;
          metrics.stop_time = camp.stop_time;
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
          `campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions ` +
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
              campaignData.push({
                campaign_id: c.id,
                campaign_name: c.name || `Google Campaign ${c.id}`,
                platform: 'google_ads',
                spend: spentPhp,
                total_budget: budgetPhp,
                impressions,
                reach: 0,
                clicks,
                ctr: impressions > 0 ? (clicks / impressions * 100).toFixed(2) + '%' : '0%',
                cost_per_click: clicks > 0 ? Math.round(spentPhp / clicks * 100) / 100 : 0,
                eng_per_peso: 0, // not applicable for Google Ads
                content_type: 'youtube_video',
                benchmark_eng_per_peso: null,
                performance_vs_benchmark: null,
                start_time: c.startDate || null,
                stop_time: c.endDate || null,
              });
            }
          }
        }
      } catch (e) { /* Google Ads query failed, continue with Meta-only */ }
    }

    if (!campaignData.length) {
      return res.status(200).json({
        campaigns: [],
        ai_analysis: { summary: 'Active campaigns found but no insight data yet.', recommendations: [] }
      });
    }

    // 3. Send to Claude for analysis
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are PGMN's campaign optimization AI. Analyze these active ad campaigns across Meta and Google Ads, and provide specific, actionable recommendations.

PGMN is a Philippine media/news network. Budget is 200,000 PHP/month. Strategy is "burst fire" — quick campaigns that maximize virality and engagement.

HISTORICAL BENCHMARKS (Feb-Mar 2026) — Meta campaigns:
- Reels: 38.5 eng/PHP (best performer)
- Trailers: 33.1 eng/PHP
- Full Episodes: 32.9 eng/PHP
- Podcasts: 28.0 eng/PHP
- Articles: 4.6 eng/PHP
- Carousels: 2.9 eng/PHP
- 3-day campaigns outperform 1-day by 2.7x
- Instagram is 2x more efficient than Facebook
- Budget sweet spot: 2K-5K PHP per campaign

KEY INSIGHTS:
- Higher budgets (5K+) get better algorithm optimization
- 1-day campaigns don't give the algorithm enough learning time
- Political/controversial content gets highest virality (shares+comments)
- Video content (reels, trailers, episodes) massively outperforms static

PLATFORM-SPECIFIC EVALUATION:
- Meta campaigns: Use eng_per_peso (engagements / spend) vs benchmarks above
- Google Ads campaigns: Use CTR and cost_per_click (no engagement metric). Good CTR > 2%, good CPC < 5 PHP

GUARDRAILS (you MUST respect these):
- Do NOT recommend KILL for campaigns less than 48 hours old (check start_time)
- Do NOT recommend KILL for campaigns with less than 100 PHP spent
- SCALE: max increase is 50% of current budget or 3,000 PHP, whichever is smaller. Total must not exceed 10,000 PHP.
- EXTEND: max 3 additional days. Total campaign duration must not exceed 7 days.

ACTIVE CAMPAIGNS:
${JSON.stringify(campaignData, null, 2)}

For each campaign, recommend one of:
- SCALE: Increase budget (specify new_budget in PHP) — performing above benchmark
- MAINTAIN: Keep running as-is — performing at benchmark
- KILL: Pause immediately — underperforming significantly
- EXTEND: Add more days (specify new_end_date as YYYY-MM-DD) — performing well but ending soon

Return your response as JSON only, no markdown:
{
  "recommendations": [
    {"campaign_id": "...", "campaign_name": "...", "platform": "meta|google_ads", "action": "SCALE|MAINTAIN|KILL|EXTEND", "reason": "...", "new_budget": null, "new_end_date": null}
  ],
  "budget_strategy": "...",
  "content_advice": "...",
  "ab_test_suggestion": "...",
  "summary": "One-line summary of overall performance"
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let aiAnalysis;
    try {
      const text = response.content[0].text;
      // Handle potential markdown code fences
      const cleaned = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
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
      const https = require('https');
      const BASE_URL = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'https://pgmn-audience.vercel.app';

      for (const rec of (aiAnalysis.recommendations || [])) {
        if (!rec.campaign_id) continue;
        const platform = rec.platform || 'meta';

        try {
          if (rec.action === 'KILL') {
            if (platform === 'google_ads') {
              const { googleAdsMutate, GOOGLE_ADS_CUSTOMER_ID } = require('../lib/google');
              await googleAdsMutate([{
                campaignOperation: {
                  update: {
                    resourceName: `customers/${GOOGLE_ADS_CUSTOMER_ID}/campaigns/${rec.campaign_id}`,
                    status: 'PAUSED',
                  },
                  updateMask: 'status',
                }
              }]);
            } else {
              await metaPost(rec.campaign_id, { status: 'PAUSED' });
            }
            actionsTaken.push({ action: 'KILL', campaign: rec.campaign_name, platform });

          } else if (rec.action === 'SCALE' && rec.new_budget) {
            if (platform === 'meta') {
              // Update adset-level budgets proportionally
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
                const newBudget = Math.round(rec.new_budget * ratio * 100); // centavos
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
