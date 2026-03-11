"""
PGMN Campaign Optimizer — Claude AI Integration
Analyzes campaign performance and makes scale/kill/maintain decisions.
"""

import os
import json
import anthropic
from dotenv import load_dotenv
from meta_api import (
    get_campaign_performance_summary, calculate_metrics,
    get_active_campaigns, get_campaign_insights,
    pause_campaign, activate_campaign, update_adset_budget
)

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))

# Historical benchmarks from Feb-Mar 2026 data analysis
BENCHMARKS = {
    'reel': {'eng_per_peso': 38.5, 'virality': 0.003},
    'trailer': {'eng_per_peso': 33.1, 'virality': 0.004},
    'full_episode': {'eng_per_peso': 32.9, 'virality': 0.003},
    'podcast': {'eng_per_peso': 28.0, 'virality': 0.001},
    'carousel': {'eng_per_peso': 2.9, 'virality': 0.008},
    'article': {'eng_per_peso': 4.6, 'virality': 0.006},
    'default': {'eng_per_peso': 15.0, 'virality': 0.003},
}


def classify_content(campaign_name):
    name = campaign_name.lower()
    if 'reel' in name:
        return 'reel'
    elif 'trailer' in name or 'teaser' in name:
        return 'trailer'
    elif 'full ep' in name or 'full episode' in name:
        return 'full_episode'
    elif 'podcast' in name:
        return 'podcast'
    elif 'carousel' in name:
        return 'carousel'
    elif 'article' in name or 'card' in name or 'post' in name:
        return 'article'
    return 'default'


def analyze_campaigns():
    """Pull all active campaign metrics and generate AI recommendations."""
    try:
        active = get_active_campaigns()
    except Exception as e:
        return {'error': str(e), 'recommendations': []}

    campaign_data = []
    for camp in active.get('data', []):
        try:
            insights = get_campaign_insights(camp['id'], date_preset='lifetime')
            if insights.get('data'):
                metrics = calculate_metrics(insights['data'][0])
                content_type = classify_content(metrics['campaign_name'])
                benchmark = BENCHMARKS.get(content_type, BENCHMARKS['default'])
                metrics['content_type'] = content_type
                metrics['benchmark_eng_per_peso'] = benchmark['eng_per_peso']
                metrics['performance_vs_benchmark'] = round(
                    metrics['eng_per_peso'] / benchmark['eng_per_peso'] * 100, 1
                ) if benchmark['eng_per_peso'] > 0 else 0
                campaign_data.append(metrics)
        except Exception:
            continue

    if not campaign_data:
        return {'campaigns': [], 'recommendations': [], 'summary': 'No active campaigns with data.'}

    prompt = f"""You are PGMN's campaign optimization AI. Analyze these active Meta ad campaigns and provide specific, actionable recommendations.

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
{json.dumps(campaign_data, indent=2)}

For each campaign, recommend one of:
- SCALE: Increase budget (specify amount) — performing above benchmark
- MAINTAIN: Keep running as-is — performing at benchmark
- KILL: Pause immediately — underperforming significantly
- EXTEND: Add more days — performing well but ending soon

Also provide:
1. An overall budget reallocation strategy
2. Content recommendations (what types to create more of)
3. One specific A/B test suggestion

Return your response as JSON:
{{
  "recommendations": [
    {{"campaign_id": "...", "campaign_name": "...", "action": "SCALE|MAINTAIN|KILL|EXTEND", "reason": "...", "new_budget": null_or_number}}
  ],
  "budget_strategy": "...",
  "content_advice": "...",
  "ab_test_suggestion": "...",
  "summary": "One-line summary of overall performance"
}}"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )

    try:
        ai_response = json.loads(response.content[0].text)
    except json.JSONDecodeError:
        ai_response = {
            'raw_response': response.content[0].text,
            'recommendations': [],
            'summary': 'Could not parse AI response as JSON'
        }

    return {
        'campaigns': campaign_data,
        'ai_analysis': ai_response,
        'timestamp': str(__import__('datetime').datetime.now())
    }


def auto_optimize(dry_run=True):
    """Run analysis and optionally execute the recommendations."""
    result = analyze_campaigns()
    ai = result.get('ai_analysis', {})
    actions_taken = []

    if not dry_run:
        for rec in ai.get('recommendations', []):
            campaign_id = rec.get('campaign_id')
            action = rec.get('action', '').upper()

            if action == 'KILL' and campaign_id:
                pause_campaign(campaign_id)
                actions_taken.append(f"PAUSED: {rec.get('campaign_name')}")

            elif action == 'SCALE' and campaign_id and rec.get('new_budget'):
                actions_taken.append(
                    f"SCALE RECOMMENDED: {rec.get('campaign_name')} to {rec['new_budget']} PHP (manual review needed)"
                )

    result['actions_taken'] = actions_taken
    result['dry_run'] = dry_run
    return result


def get_quick_stats():
    """Fast summary of current campaign performance without AI analysis."""
    try:
        perf = get_campaign_performance_summary(days=7)
    except Exception as e:
        return {'error': str(e)}

    campaigns = []
    total_spend = 0
    total_engagements = 0

    for insight in perf.get('data', []):
        metrics = calculate_metrics(insight)
        campaigns.append(metrics)
        total_spend += metrics['spend']
        total_engagements += metrics['engagements']

    campaigns.sort(key=lambda x: x['eng_per_peso'], reverse=True)

    return {
        'total_spend': total_spend,
        'total_engagements': total_engagements,
        'overall_eng_per_peso': round(total_engagements / total_spend, 2) if total_spend > 0 else 0,
        'campaign_count': len(campaigns),
        'top_performers': campaigns[:5],
        'worst_performers': campaigns[-3:] if len(campaigns) > 3 else [],
    }
