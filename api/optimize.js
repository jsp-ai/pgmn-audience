const Anthropic = require('@anthropic-ai/sdk');
const { metaGet, metaPost, calculateMetrics, AD_ACCOUNT_ID } = require('../lib/meta');

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

    if (!campaignData.length) {
      return res.status(200).json({
        campaigns: [],
        ai_analysis: { summary: 'Active campaigns found but no insight data yet.', recommendations: [] }
      });
    }

    // 3. Send to Claude for analysis
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are PGMN's campaign optimization AI. Analyze these active Meta ad campaigns and provide specific, actionable recommendations.

PGMN is a Philippine media/news network. Budget is 200,000 PHP/month. Strategy is "burst fire" — quick campaigns that maximize virality and engagement.

HISTORICAL BENCHMARKS (Feb-Mar 2026):
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

ACTIVE CAMPAIGNS:
${JSON.stringify(campaignData, null, 2)}

For each campaign, recommend one of:
- SCALE: Increase budget (specify amount) — performing above benchmark
- MAINTAIN: Keep running as-is — performing at benchmark
- KILL: Pause immediately — underperforming significantly
- EXTEND: Add more days — performing well but ending soon

Also provide:
1. An overall budget reallocation strategy
2. Content recommendations (what types to create more of)
3. One specific A/B test suggestion

Return your response as JSON only, no markdown:
{
  "recommendations": [
    {"campaign_id": "...", "campaign_name": "...", "action": "SCALE|MAINTAIN|KILL|EXTEND", "reason": "...", "new_budget": null}
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
      for (const rec of (aiAnalysis.recommendations || [])) {
        if (rec.action === 'KILL' && rec.campaign_id) {
          await metaPost(rec.campaign_id, { status: 'PAUSED' });
          actionsTaken.push(`PAUSED: ${rec.campaign_name}`);
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
