"""
PGMN Meta Marketing API Integration
Handles campaign creation, monitoring, and optimization via the Graph API.
"""

import os
import json
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

ACCESS_TOKEN = os.getenv('META_ACCESS_TOKEN')
AD_ACCOUNT_ID = os.getenv('META_AD_ACCOUNT_ID')
API_VERSION = os.getenv('META_API_VERSION', 'v25.0')
BASE_URL = f"https://graph.facebook.com/{API_VERSION}"


def _request(method, endpoint, params=None, data=None):
    url = f"{BASE_URL}/{endpoint}"
    default_params = {'access_token': ACCESS_TOKEN}
    if params:
        default_params.update(params)
    resp = requests.request(method, url, params=default_params if method == 'GET' else None,
                           data={**default_params, **(data or {})} if method == 'POST' else None)
    result = resp.json()
    if 'error' in result:
        raise Exception(f"Meta API Error: {result['error']['message']}")
    return result


# ─── READ OPERATIONS ───

def get_ad_accounts():
    return _request('GET', 'me/adaccounts', {
        'fields': 'name,account_id,account_status,currency,timezone_name,balance,amount_spent'
    })


def get_campaigns(status_filter=None, limit=25):
    params = {
        'fields': 'name,status,objective,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining',
        'limit': limit
    }
    if status_filter:
        params['effective_status'] = json.dumps(status_filter)
    return _request('GET', f'{AD_ACCOUNT_ID}/campaigns', params)


def get_active_campaigns():
    return get_campaigns(status_filter=['ACTIVE'])


def get_campaign_insights(campaign_id, date_preset='last_7d'):
    return _request('GET', f'{campaign_id}/insights', {
        'fields': ','.join([
            'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
            'actions', 'cost_per_action_type', 'cpm', 'cpp', 'ctr',
            'clicks', 'unique_clicks', 'video_thruplay_watched_actions',
            'video_p25_watched_actions', 'video_p50_watched_actions',
            'video_p75_watched_actions', 'video_p100_watched_actions'
        ]),
        'date_preset': date_preset
    })


def get_adsets(campaign_id):
    return _request('GET', f'{campaign_id}/adsets', {
        'fields': 'name,status,daily_budget,lifetime_budget,targeting,optimization_goal,billing_event,start_time,end_time'
    })


def get_ads(adset_id):
    return _request('GET', f'{adset_id}/ads', {
        'fields': 'name,status,creative,tracking_specs'
    })


def get_page_posts(page_id, limit=10):
    return _request('GET', f'{page_id}/posts', {
        'fields': 'message,created_time,permalink_url,full_picture,type',
        'limit': limit
    })


# ─── WRITE OPERATIONS ───

def create_campaign(name, objective='OUTCOME_ENGAGEMENT', status='PAUSED',
                    special_ad_categories=None):
    data = {
        'name': name,
        'objective': objective,
        'status': status,
        'special_ad_categories': json.dumps(special_ad_categories or []),
    }
    return _request('POST', f'{AD_ACCOUNT_ID}/campaigns', data=data)


def create_adset(campaign_id, name, budget_php, duration_days,
                 optimization_goal='POST_ENGAGEMENT', billing_event='IMPRESSIONS',
                 targeting=None, placement='automatic'):
    now = datetime.utcnow() + timedelta(hours=8)  # Manila time
    end = now + timedelta(days=duration_days)

    default_targeting = {
        'geo_locations': {'countries': ['PH']},
        'age_min': 18,
        'age_max': 65,
        'publisher_platforms': ['facebook', 'instagram'],
    }

    if placement == 'facebook_only':
        default_targeting['publisher_platforms'] = ['facebook']
    elif placement == 'instagram_only':
        default_targeting['publisher_platforms'] = ['instagram']

    if targeting:
        default_targeting.update(targeting)

    budget_centavos = int(budget_php * 100)

    data = {
        'campaign_id': campaign_id,
        'name': name,
        'lifetime_budget': str(budget_centavos),
        'optimization_goal': optimization_goal,
        'billing_event': billing_event,
        'start_time': now.strftime('%Y-%m-%dT%H:%M:%S+0800'),
        'end_time': end.strftime('%Y-%m-%dT%H:%M:%S+0800'),
        'targeting': json.dumps(default_targeting),
        'status': 'PAUSED',
    }
    return _request('POST', f'{AD_ACCOUNT_ID}/adsets', data=data)


def create_ad_from_post(adset_id, name, page_id, post_id):
    creative_data = {
        'name': f'{name} - Creative',
        'object_story_id': f'{page_id}_{post_id}',
    }
    creative = _request('POST', f'{AD_ACCOUNT_ID}/adcreatives', data=creative_data)

    ad_data = {
        'name': name,
        'adset_id': adset_id,
        'creative': json.dumps({'creative_id': creative['id']}),
        'status': 'PAUSED',
    }
    return _request('POST', f'{AD_ACCOUNT_ID}/ads', data=ad_data)


def create_ad_from_url(adset_id, name, page_id, link_url, message='', headline=''):
    creative_data = {
        'name': f'{name} - Creative',
        'object_story_spec': json.dumps({
            'page_id': page_id,
            'link_data': {
                'link': link_url,
                'message': message,
                'name': headline,
            }
        }),
    }
    creative = _request('POST', f'{AD_ACCOUNT_ID}/adcreatives', data=creative_data)

    ad_data = {
        'name': name,
        'adset_id': adset_id,
        'creative': json.dumps({'creative_id': creative['id']}),
        'status': 'PAUSED',
    }
    return _request('POST', f'{AD_ACCOUNT_ID}/ads', data=ad_data)


# ─── CONTROL OPERATIONS ───

def update_campaign_status(campaign_id, status):
    """status: ACTIVE, PAUSED, ARCHIVED"""
    return _request('POST', campaign_id, data={'status': status})


def update_adset_budget(adset_id, new_budget_php):
    budget_centavos = int(new_budget_php * 100)
    return _request('POST', adset_id, data={'lifetime_budget': str(budget_centavos)})


def pause_campaign(campaign_id):
    return update_campaign_status(campaign_id, 'PAUSED')


def activate_campaign(campaign_id):
    return update_campaign_status(campaign_id, 'ACTIVE')


def archive_campaign(campaign_id):
    return update_campaign_status(campaign_id, 'ARCHIVED')


# ─── BURST FIRE: FULL LAUNCH FLOW ───

def launch_burst_campaign(content_url, budget_php, duration_days, page_id,
                          post_id=None, campaign_name=None, platform='both',
                          ab_test=False):
    """
    One-call campaign launcher.

    content_url: The FB/IG post URL or link to promote
    budget_php: Total budget in PHP
    duration_days: How many days to run
    page_id: Your Facebook Page ID
    post_id: If boosting an existing post, provide the post ID
    platform: 'both', 'facebook_only', 'instagram_only'
    ab_test: If True, splits budget across 2 ad sets with different audiences
    """
    if not campaign_name:
        short_name = content_url.split('/')[-1][:30] if '/' in content_url else 'Campaign'
        campaign_name = f"PGMN Burst - {short_name} - {budget_php}PHP {duration_days}d"

    # 1. Create campaign
    campaign = create_campaign(campaign_name, status='PAUSED')
    campaign_id = campaign['id']

    results = {'campaign_id': campaign_id, 'adsets': [], 'ads': []}

    if ab_test:
        # Split budget: 50/50 for A/B test
        budget_each = budget_php / 2

        # Variation A: Broad targeting (18-65)
        adset_a = create_adset(
            campaign_id, f"{campaign_name} - Broad",
            budget_each, duration_days, placement=platform
        )
        results['adsets'].append(adset_a)

        # Variation B: Core demo (25-44)
        adset_b = create_adset(
            campaign_id, f"{campaign_name} - Core 25-44",
            budget_each, duration_days, placement=platform,
            targeting={'age_min': 25, 'age_max': 44}
        )
        results['adsets'].append(adset_b)

        # Create ads for both ad sets
        for adset in [adset_a, adset_b]:
            if post_id:
                ad = create_ad_from_post(adset['id'], f"Ad - {adset['id'][-6:]}", page_id, post_id)
            else:
                ad = create_ad_from_url(adset['id'], f"Ad - {adset['id'][-6:]}", page_id, content_url)
            results['ads'].append(ad)
    else:
        # Single ad set
        adset = create_adset(
            campaign_id, f"{campaign_name} - Main",
            budget_php, duration_days, placement=platform
        )
        results['adsets'].append(adset)

        if post_id:
            ad = create_ad_from_post(adset['id'], f"Ad - Main", page_id, post_id)
        else:
            ad = create_ad_from_url(adset['id'], f"Ad - Main", page_id, content_url)
        results['ads'].append(ad)

    return results


# ─── ANALYTICS ───

def get_campaign_performance_summary(days=7):
    """Get performance for all recent campaigns."""
    params = {
        'fields': ','.join([
            'campaign_name', 'campaign_id', 'spend', 'impressions', 'reach',
            'actions', 'cost_per_action_type', 'cpm', 'ctr', 'clicks',
        ]),
        'date_preset': f'last_{days}d' if days <= 30 else 'last_30d',
        'level': 'campaign',
        'limit': 50,
    }
    return _request('GET', f'{AD_ACCOUNT_ID}/insights', params)


def calculate_metrics(insight):
    """Extract key metrics from a campaign insight row."""
    spend = float(insight.get('spend', 0))
    impressions = int(insight.get('impressions', 0))
    reach = int(insight.get('reach', 0))
    clicks = int(insight.get('clicks', 0))

    engagements = 0
    shares = 0
    comments = 0
    video_views = 0

    for action in insight.get('actions', []):
        if action['action_type'] == 'post_engagement':
            engagements = int(action['value'])
        elif action['action_type'] == 'post':
            shares = int(action['value'])
        elif action['action_type'] == 'comment':
            comments = int(action['value'])
        elif action['action_type'] == 'video_view':
            video_views = int(action['value'])

    return {
        'campaign_name': insight.get('campaign_name'),
        'campaign_id': insight.get('campaign_id'),
        'spend': spend,
        'impressions': impressions,
        'reach': reach,
        'clicks': clicks,
        'engagements': engagements,
        'shares': shares,
        'comments': comments,
        'video_views': video_views,
        'cpm': round(spend / impressions * 1000, 2) if impressions > 0 else 0,
        'eng_per_peso': round(engagements / spend, 2) if spend > 0 else 0,
        'virality': round((shares + comments) / engagements, 4) if engagements > 0 else 0,
    }
