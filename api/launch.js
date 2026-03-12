const { metaPost, AD_ACCOUNT_ID } = require('../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { content_url, budget_php, duration_days, page_id, post_id, campaign_name, platform, ab_test, countries } = req.body;
    const name = campaign_name || `PGMN Burst - ${budget_php}PHP ${duration_days}d`;

    const campaign = await metaPost(`${AD_ACCOUNT_ID}/campaigns`, {
      name, objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED',
      special_ad_categories: '[]'
    });
    if (campaign.error) return res.status(400).json(campaign);

    const now = new Date();
    const end = new Date(now.getTime() + duration_days * 86400000);
    const fmt = d => d.toISOString().replace(/\.\d+Z$/, '+0800');

    const targetCountries = countries && countries.length ? countries : ['PH'];
    const targeting = { geo_locations: { countries: targetCountries }, age_min: 18, age_max: 65 };
    if (platform === 'facebook_only') targeting.publisher_platforms = ['facebook'];
    else if (platform === 'instagram_only') targeting.publisher_platforms = ['instagram'];
    else targeting.publisher_platforms = ['facebook', 'instagram'];

    const results = { campaign_id: campaign.id, adsets: [], ads: [] };

    const createAdSet = async (adsetName, budgetPhp, extraTargeting = {}) => {
      const t = { ...targeting, ...extraTargeting };
      const adset = await metaPost(`${AD_ACCOUNT_ID}/adsets`, {
        campaign_id: campaign.id, name: adsetName,
        lifetime_budget: String(Math.round(budgetPhp * 100)),
        optimization_goal: 'POST_ENGAGEMENT', billing_event: 'IMPRESSIONS',
        start_time: fmt(now), end_time: fmt(end),
        targeting: JSON.stringify(t), status: 'PAUSED'
      });
      results.adsets.push(adset);
      if (post_id) {
        const creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, {
          name: `${adsetName} - Creative`, object_story_id: `${page_id}_${post_id}`
        });
        const ad = await metaPost(`${AD_ACCOUNT_ID}/ads`, {
          name: `${adsetName} - Ad`, adset_id: adset.id,
          creative: JSON.stringify({ creative_id: creative.id }), status: 'PAUSED'
        });
        results.ads.push(ad);
      }
      return adset;
    };

    if (ab_test) {
      await createAdSet(`${name} - Broad`, budget_php / 2);
      await createAdSet(`${name} - Core 25-44`, budget_php / 2, { age_min: 25, age_max: 44 });
    } else {
      await createAdSet(`${name} - Main`, budget_php);
    }

    res.status(200).json({ status: 'created', data: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
