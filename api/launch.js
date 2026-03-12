const { metaPost, AD_ACCOUNT_ID } = require('../lib/meta');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const {
      budget_php, duration_days, page_id, post_id, campaign_name,
      platform, ab_test, countries, content_type,
      object_story_id, creative_id,
      use_ig_media, ig_media_id, ig_account_id,
    } = req.body;

    const name = campaign_name || `PGMN Campaign - ${budget_php}PHP ${duration_days}d`;

    // Determine objective & optimization based on content type
    const isReel = content_type === 'reel';
    const objective = isReel ? 'OUTCOME_AWARENESS' : 'OUTCOME_ENGAGEMENT';
    const optimizationGoal = isReel ? 'THRUPLAY' : 'POST_ENGAGEMENT';

    // 1. Create campaign
    const campaign = await metaPost(`${AD_ACCOUNT_ID}/campaigns`, {
      name, objective, status: 'PAUSED',
      special_ad_categories: '[]',
      is_adset_budget_sharing_enabled: 'false'
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

    const results = { campaign_id: campaign.id, adsets: [], ads: [], objective, optimization_goal: optimizationGoal };
    const storyId = object_story_id || (page_id && post_id ? `${page_id}_${post_id}` : null);

    const createAdSet = async (adsetName, budgetPhp, extraTargeting = {}) => {
      const t = { ...targeting, ...extraTargeting };
      const adset = await metaPost(`${AD_ACCOUNT_ID}/adsets`, {
        campaign_id: campaign.id, name: adsetName,
        lifetime_budget: String(Math.round(budgetPhp * 100)),
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        optimization_goal: optimizationGoal, billing_event: 'IMPRESSIONS',
        destination_type: 'ON_POST',
        start_time: fmt(now), end_time: fmt(end),
        targeting: JSON.stringify(t), status: 'PAUSED'
      });
      if (adset.error) {
        results.adsets.push({ error: adset.error });
        return adset;
      }
      results.adsets.push(adset);

      // ─── Determine creative to use ───
      let creativeIdToUse = creative_id; // Reuse existing creative from resolve-post

      if (!creativeIdToUse) {
        // No existing creative — create a new one
        let creative;
        if (use_ig_media && ig_media_id && ig_account_id) {
          creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, {
            name: `${adsetName} - Creative`,
            instagram_user_id: ig_account_id,
            source_instagram_media_id: ig_media_id,
          });
        } else if (storyId) {
          creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, {
            name: `${adsetName} - Creative`, object_story_id: storyId
          });
        }
        if (!creative) {
          results.ads.push({ error: 'No creative_id, ig_media, or object_story_id provided' });
          return adset;
        }
        if (creative.error) {
          results.ads.push({ error: creative.error });
          return adset;
        }
        creativeIdToUse = creative.id;
      }

      // 3. Create ad using the creative
      const ad = await metaPost(`${AD_ACCOUNT_ID}/ads`, {
        name: `${adsetName} - Ad`, adset_id: adset.id,
        creative: JSON.stringify({ creative_id: creativeIdToUse }), status: 'PAUSED'
      });
      if (ad.error) { results.ads.push({ error: ad.error }); } else { results.ads.push(ad); }
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
