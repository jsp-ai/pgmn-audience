const https = require('https');
const { metaGet, metaPost, AD_ACCOUNT_ID } = require('../lib/meta');
const {
  googleAdsMutate,
  isGoogleAdsConfigured,
  formatDateForGoogle,
  GEO_TARGET_CONSTANTS,
  GOOGLE_ADS_CUSTOMER_ID,
} = require('../lib/google');

const PAGE_ID = (process.env.META_PAGE_ID || '394530007066390').trim();
const PAGE_ACCESS_TOKEN = (process.env.META_PAGE_ACCESS_TOKEN || '').trim().replace(/\\n$/, '');
const IG_ACCOUNT_ID = (process.env.META_IG_ACCOUNT_ID || '').trim();
const API_VERSION = process.env.META_API_VERSION || 'v25.0';

// Query with Page Access Token (needed for IG account lookups)
function pageGet(endpoint, params = {}) {
  const token = PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
  return new Promise((resolve) => {
    params.access_token = token;
    const qs = new URLSearchParams(params).toString();
    const reqUrl = `https://graph.facebook.com/${API_VERSION}/${endpoint}?${qs}`;
    https.get(reqUrl, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: 'Invalid JSON' }); }
      });
    }).on('error', () => resolve({ error: 'Network error' }));
  });
}

// Get the IG actor ID for ad creatives — returns { id, source } for debugging
let igActorCache = { id: null, source: null, ts: 0 };
async function getIgActorId() {
  if (igActorCache.id && Date.now() - igActorCache.ts < 300000) {
    return { id: igActorCache.id, source: igActorCache.source };
  }

  // 0. Environment variable
  if (IG_ACCOUNT_ID) {
    igActorCache = { id: IG_ACCOUNT_ID, source: 'env_var', ts: Date.now() };
    return { id: IG_ACCOUNT_ID, source: 'env_var' };
  }

  // 1. Try Page-level instagram_accounts with Page Access Token
  try {
    const pageIg = await pageGet(`${PAGE_ID}/instagram_accounts`, { fields: 'id,username' });
    if (pageIg.data && pageIg.data.length > 0) {
      const id = pageIg.data[0].id;
      igActorCache = { id, source: `page_ig(${pageIg.data[0].username || 'unknown'})`, ts: Date.now() };
      return { id, source: igActorCache.source };
    }
  } catch (e) { /* continue */ }

  // 2. Try page-backed IG accounts
  try {
    const backed = await pageGet(`${PAGE_ID}/page_backed_instagram_accounts`);
    if (backed.data && backed.data.length > 0) {
      const id = backed.data[0].id;
      igActorCache = { id, source: 'page_backed', ts: Date.now() };
      return { id, source: 'page_backed' };
    }
  } catch (e) { /* continue */ }

  // 3. Fallback: ad account level
  try {
    const adIg = await metaGet(`${AD_ACCOUNT_ID}/instagram_accounts`, { fields: 'id,username' });
    if (adIg.data && adIg.data.length > 0) {
      const id = adIg.data[0].id;
      igActorCache = { id, source: `ad_account(${adIg.data[0].username || 'unknown'})`, ts: Date.now() };
      return { id, source: igActorCache.source };
    }
  } catch (e) { /* continue */ }

  return null;
}

// ─── YouTube / Google Ads launch handler ───
async function launchYouTube(req, res) {
  if (!isGoogleAdsConfigured()) {
    return res.status(500).json({
      error: 'Google Ads API is not configured. Please set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_REFRESH_TOKEN, and GOOGLE_ADS_CUSTOMER_ID environment variables.',
    });
  }

  try {
    const {
      video_id,
      video_title,
      video_description,
      thumbnail_url,
      budget_php,
      duration_days,
      campaign_name,
      countries = ['PH'],
      ab_test = false,
      campaign_type = 'views',
      channel_id = '',
      channel_name = '',
    } = req.body;

    if (!video_id) return res.status(400).json({ error: 'video_id is required' });
    if (!budget_php) return res.status(400).json({ error: 'budget_php is required' });
    if (!duration_days) return res.status(400).json({ error: 'duration_days is required' });
    if (campaign_type === 'subscribers' && !channel_id) {
      return res.status(400).json({ error: 'channel_id is required for subscriber campaigns. Ensure video was resolved with YouTube Data API.' });
    }

    const isSubscribers = campaign_type === 'subscribers';
    const ctaText = isSubscribers ? 'Subscribe' : 'Watch more';
    const finalUrl = isSubscribers
      ? `https://www.youtube.com/channel/${channel_id}?sub_confirmation=1`
      : `https://www.youtube.com/watch?v=${video_id}`;

    const customerId = GOOGLE_ADS_CUSTOMER_ID;
    const customerResourceName = `customers/${customerId}`;

    // --- Dates ---
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(duration_days));

    // --- Budget in micros (1 PHP = 1,000,000 micros) ---
    const budgetMicros = Math.round(parseFloat(budget_php) * 1000000);

    // --- Build temp resource names for atomic mutate ---
    const budgetTempId = '-1';
    const campaignTempId = '-2';
    const adGroupTempId = '-3';
    const videoAssetTempId = '-4';

    // --- Headline and description from video metadata ---
    const headline = (video_title || campaign_name || 'Watch Now').substring(0, 30);
    const longHeadline = (video_title || campaign_name || 'Watch this video').substring(0, 90);
    const description = (video_description || video_title || 'Watch now').substring(0, 90);

    // --- Build Geo Targeting criteria ---
    const geoOperations = countries
      .filter(c => GEO_TARGET_CONSTANTS[c])
      .map(c => ({
        campaignCriterionOperation: {
          create: {
            campaign: `${customerResourceName}/campaigns/${campaignTempId}`,
            location: {
              geoTargetConstant: `geoTargetConstants/${GEO_TARGET_CONSTANTS[c]}`,
            },
          },
        },
      }));

    // --- Build mutate operations ---
    const operations = [
      // 1. Campaign Budget
      {
        campaignBudgetOperation: {
          create: {
            resourceName: `${customerResourceName}/campaignBudgets/${budgetTempId}`,
            name: `${campaign_name} - Budget`,
            amountMicros: budgetMicros.toString(),
            deliveryMethod: 'STANDARD',
            explicitlyShared: false,
          },
        },
      },
      // 2. Demand Gen Campaign
      {
        campaignOperation: {
          create: {
            resourceName: `${customerResourceName}/campaigns/${campaignTempId}`,
            name: campaign_name || `YouTube - ${video_id}`,
            advertisingChannelType: 'DEMAND_GEN',
            status: 'ENABLED',
            campaignBudget: `${customerResourceName}/campaignBudgets/${budgetTempId}`,
            startDate: formatDateForGoogle(startDate),
            endDate: formatDateForGoogle(endDate),
            ...(isSubscribers ? { maximizeConversions: {} } : { maximizeClicks: {} }),
          },
        },
      },
      // 3. Geo Targeting
      ...geoOperations,
      // 4. Video Asset
      {
        assetOperation: {
          create: {
            resourceName: `${customerResourceName}/assets/${videoAssetTempId}`,
            name: `YT Video - ${video_id}`,
            youtubeVideoAsset: {
              youtubeVideoId: video_id,
            },
          },
        },
      },
      // 5. Ad Group
      {
        adGroupOperation: {
          create: {
            resourceName: `${customerResourceName}/adGroups/${adGroupTempId}`,
            campaign: `${customerResourceName}/campaigns/${campaignTempId}`,
            name: `${campaign_name || video_id} - Main`,
            status: 'ENABLED',
          },
        },
      },
      // 6. Ad Group Ad (Demand Gen Video Responsive Ad)
      {
        adGroupAdOperation: {
          create: {
            adGroup: `${customerResourceName}/adGroups/${adGroupTempId}`,
            status: 'ENABLED',
            ad: {
              demandGenVideoResponsiveAd: {
                headlines: [{ text: headline }],
                longHeadlines: [{ text: longHeadline }],
                descriptions: [{ text: description }],
                videos: [{
                  asset: `${customerResourceName}/assets/${videoAssetTempId}`,
                }],
                callToActions: [{ text: ctaText }],
                breadcrumb1: 'PGMN',
              },
              finalUrls: [finalUrl],
            },
          },
        },
      },
    ];

    // --- A/B Test: add a second ad group with different age targeting ---
    if (ab_test) {
      const adGroup2TempId = '-5';
      operations.push(
        {
          adGroupOperation: {
            create: {
              resourceName: `${customerResourceName}/adGroups/${adGroup2TempId}`,
              campaign: `${customerResourceName}/campaigns/${campaignTempId}`,
              name: `${campaign_name || video_id} - Core 25-44`,
              status: 'ENABLED',
            },
          },
        },
        {
          adGroupCriterionOperation: {
            create: {
              adGroup: `${customerResourceName}/adGroups/${adGroup2TempId}`,
              ageRange: { type: 'AGE_RANGE_25_34' },
            },
          },
        },
        {
          adGroupCriterionOperation: {
            create: {
              adGroup: `${customerResourceName}/adGroups/${adGroup2TempId}`,
              ageRange: { type: 'AGE_RANGE_35_44' },
            },
          },
        },
        {
          adGroupAdOperation: {
            create: {
              adGroup: `${customerResourceName}/adGroups/${adGroup2TempId}`,
              status: 'ENABLED',
              ad: {
                demandGenVideoResponsiveAd: {
                  headlines: [{ text: headline }],
                  longHeadlines: [{ text: longHeadline }],
                  descriptions: [{ text: description }],
                  videos: [{
                    asset: `${customerResourceName}/assets/${videoAssetTempId}`,
                  }],
                  callToActions: [{ text: ctaText }],
                  breadcrumb1: 'PGMN',
                },
                finalUrls: [finalUrl],
              },
            },
          },
        }
      );
    }

    // --- Send atomic mutate request ---
    const result = await googleAdsMutate(operations);

    if (result.error) {
      const errorDetails = result.error.details
        ? result.error.details.map(d => d.errors ? d.errors.map(e => e.message).join('; ') : JSON.stringify(d)).join(' | ')
        : result.error.message;
      return res.status(200).json({
        status: 'error',
        error: `Google Ads API error: ${result.error.message} — ${errorDetails}`,
        details: result.error,
      });
    }

    // --- Parse results ---
    const ytResults = result.mutateOperationResponses || [];
    const campaignResult = ytResults.find(r => r.campaignResult);
    const adGroupResults = ytResults.filter(r => r.adGroupResult);
    const adResults = ytResults.filter(r => r.adGroupAdResult);

    return res.status(200).json({
      status: 'success',
      platform: 'youtube',
      data: {
        campaign: campaignResult ? campaignResult.campaignResult.resourceName : null,
        ad_groups: adGroupResults.map(r => r.adGroupResult.resourceName),
        ads: adResults.map(r => r.adGroupAdResult.resourceName),
        video_id,
        campaign_type,
        budget_php,
        duration_days,
        countries,
      },
    });

  } catch (err) {
    return res.status(500).json({
      status: 'error',
      error: `YouTube campaign launch failed: ${err.message}`,
    });
  }
}

// ─── Meta (FB/IG) launch handler ───
async function launchMeta(req, res) {
  try {
    const {
      budget_php, duration_days, page_id, post_id, campaign_name,
      platform, ab_test, political, countries, cities, content_type,
      object_story_id, creative_id,
      use_ig_media, ig_media_id, ig_account_id,
    } = req.body;

    const name = campaign_name || `PGMN Campaign - ${budget_php}PHP ${duration_days}d`;

    // Determine optimization based on content type
    // All content uses OUTCOME_ENGAGEMENT objective
    // Videos/reels: THRUPLAY (maximize video views under engagement)
    // Photos/text: POST_ENGAGEMENT (maximize likes/comments/shares)
    const isReel = content_type === 'reel';
    const objective = 'OUTCOME_ENGAGEMENT';
    const optimizationGoal = isReel ? 'THRUPLAY' : 'POST_ENGAGEMENT';

    // 1. Create campaign
    const campaignParams = {
      name, objective, status: 'ACTIVE',
      special_ad_categories: political ? '["ISSUES_ELECTIONS_POLITICS"]' : '[]',
      is_adset_budget_sharing_enabled: 'true'
    };
    if (political) {
      const targetCountries = countries && countries.length ? countries : ['PH'];
      campaignParams.special_ad_category_country = JSON.stringify(targetCountries);
    }
    const campaign = await metaPost(`${AD_ACCOUNT_ID}/campaigns`, campaignParams);
    if (campaign.error) return res.status(400).json(campaign);

    const now = new Date();
    const end = new Date(now.getTime() + duration_days * 86400000);
    const fmt = d => d.toISOString().replace(/\.\d+Z$/, '+0800');

    const targetCountries = countries && countries.length ? countries : ['PH'];
    const geoLocations = {};
    if (cities && cities.length > 0) {
      geoLocations.cities = cities;
      const otherCountries = targetCountries.filter(c => c !== 'PH');
      if (otherCountries.length > 0) geoLocations.countries = otherCountries;
    } else {
      geoLocations.countries = targetCountries;
    }
    const targeting = { geo_locations: geoLocations, age_min: 18, age_max: 65 };
    if (platform === 'facebook_only') targeting.publisher_platforms = ['facebook'];
    else if (platform === 'instagram_only') targeting.publisher_platforms = ['instagram'];
    else targeting.publisher_platforms = ['facebook', 'instagram'];

    const results = { campaign_id: campaign.id, adsets: [], ads: [], objective, optimization_goal: optimizationGoal };
    const storyId = object_story_id || (page_id && post_id ? `${page_id}_${post_id}` : null);

    // Pre-fetch IG actor if needed (so we fail fast before creating adsets)
    let igActorId = null;
    let igActorSource = null;
    if (use_ig_media && ig_media_id && (!creative_id || political)) {
      const igResult = await getIgActorId();
      if (!igResult) {
        return res.status(400).json({
          error: 'No Instagram account found for ads. Connect your IG account to your Page in Meta Business Settings > Instagram Accounts.',
          campaign_id: campaign.id,
        });
      }
      igActorId = igResult.id;
      igActorSource = igResult.source;
    }

    const createAdSet = async (adsetName, budgetPhp, extraTargeting = {}) => {
      const t = { ...targeting, ...extraTargeting };
      const adsetParams = {
        campaign_id: campaign.id, name: adsetName,
        lifetime_budget: String(Math.round(budgetPhp * 100)),
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        optimization_goal: optimizationGoal, billing_event: 'IMPRESSIONS',
        start_time: fmt(now), end_time: fmt(end),
        targeting: JSON.stringify(t), status: 'ACTIVE'
      };
      // Set destination_type: ON_AD for video/reel ads (engagement on ad), ON_POST for photos
      if (isReel) adsetParams.destination_type = 'ON_AD';
      else adsetParams.destination_type = 'ON_POST';
      const adset = await metaPost(`${AD_ACCOUNT_ID}/adsets`, adsetParams);
      if (adset.error) {
        results.adsets.push({ error: adset.error });
        return adset;
      }
      results.adsets.push(adset);

      // ─── Determine creative to use ───
      // For political ads, ALWAYS create a new creative with authorization_category
      // so it matches the campaign's special_ad_categories. Reusing an existing
      // creative that lacks the POLITICAL flag causes Meta to reject the ad.
      let creativeIdToUse = political ? null : creative_id;

      if (!creativeIdToUse) {
        let creative;
        const creativeParams = { name: `${adsetName} - Creative` };
        if (political) creativeParams.authorization_category = 'POLITICAL';

        if (use_ig_media && ig_media_id && igActorId) {
          // IG post: instagram_actor_id was deprecated in v22.0, use instagram_user_id + object_id
          creativeParams.instagram_user_id = igActorId;
          creativeParams.source_instagram_media_id = ig_media_id;
          creativeParams.object_id = PAGE_ID;
          creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, creativeParams);
        } else if (storyId) {
          creativeParams.object_story_id = storyId;
          // For reels: auto-swap copyrighted music with Meta Sound Collection audio
          // This mimics the native "Boost" button behavior that bypasses music copyright restrictions
          if (isReel) {
            creativeParams.asset_feed_spec = JSON.stringify({
              audios: [{ type: "random" }]
            });
          }
          creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, creativeParams);

          // Fallback for FB reels: if object_story_id fails (video ID ≠ post ID),
          // try multiple approaches to find the correct promotable post ID.
          if (creative.error && creative.error.error_subcode === 1487472 && isReel && post_id) {
            const fallbackDebug = {};

            // Approach 1: Query the video directly for permalink (may reveal post ID)
            try {
              const videoInfo = await pageGet(post_id, { fields: 'id,permalink_url,from' });
              fallbackDebug.video_info = videoInfo.error
                ? { error: videoInfo.error.message }
                : { id: videoInfo.id, permalink: videoInfo.permalink_url, from: videoInfo.from };
              // Try extracting post ID from permalink (e.g., /posts/XXXXX/ or story_fbid=XXXXX)
              if (videoInfo.permalink_url) {
                const storyMatch = videoInfo.permalink_url.match(/story_fbid=(\d+)/);
                const postsMatch = videoInfo.permalink_url.match(/\/posts\/(\d+)/);
                const extractedId = (storyMatch && storyMatch[1]) || (postsMatch && postsMatch[1]);
                if (extractedId && extractedId !== post_id) {
                  const fallbackParams = { name: `${adsetName} - Creative` };
                  if (political) fallbackParams.authorization_category = 'POLITICAL';
                  fallbackParams.object_story_id = `${PAGE_ID}_${extractedId}`;
                  fallbackDebug.permalink_extracted_id = extractedId;
                  creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, fallbackParams);
                }
              }
            } catch (e) { fallbackDebug.video_error = e.message; }

            // Approach 2: Search promotable_posts
            if (creative.error) {
              try {
                const promotable = await pageGet(`${PAGE_ID}/promotable_posts`, {
                  fields: 'id,permalink_url,attachments{target{id},media_type,type}',
                  limit: '50',
                  include_inline_create: 'true',
                });
                fallbackDebug.promotable_count = promotable.data ? promotable.data.length : 0;
                fallbackDebug.promotable_error = promotable.error ? promotable.error.message : null;
                // Log first 5 for debugging
                fallbackDebug.promotable_sample = (promotable.data || []).slice(0, 5).map(p => ({
                  id: p.id,
                  permalink: p.permalink_url,
                  attachments: p.attachments && p.attachments.data
                    ? p.attachments.data.map(a => ({ target_id: a.target && a.target.id, type: a.type || a.media_type }))
                    : null,
                }));
                if (promotable.data) {
                  for (const p of promotable.data) {
                    const hasVideo = p.attachments && p.attachments.data &&
                      p.attachments.data.some(att => att.target && att.target.id === post_id);
                    const inPermalink = p.permalink_url && p.permalink_url.includes(post_id);
                    if (hasVideo || inPermalink) {
                      const fallbackParams = { name: `${adsetName} - Creative` };
                      if (political) fallbackParams.authorization_category = 'POLITICAL';
                      fallbackParams.object_story_id = p.id;
                      fallbackDebug.matched_post_id = p.id;
                      creative = await metaPost(`${AD_ACCOUNT_ID}/adcreatives`, fallbackParams);
                      break;
                    }
                  }
                }
              } catch (e) { fallbackDebug.promotable_error = e.message; }
            }

            // Attach fallback debug info to the error
            if (creative.error) {
              creative.error._fallback_debug = fallbackDebug;
            }
          }
        }
        if (!creative) {
          results.ads.push({ error: 'No creative_id, ig_media, or object_story_id provided' });
          return adset;
        }
        if (creative.error) {
          // Include debug info so we can see exactly what was sent
          creative.error._debug = {
            ig_user_id_used: creativeParams.instagram_user_id || null,
            ig_actor_source: igActorSource || 'n/a',
            ig_media_id_used: creativeParams.source_instagram_media_id || null,
            object_story_id_used: creativeParams.object_story_id || null,
          };
          results.ads.push({ error: creative.error });
          return adset;
        }
        creativeIdToUse = creative.id;
      }

      // 3. Create ad using the creative
      const ad = await metaPost(`${AD_ACCOUNT_ID}/ads`, {
        name: `${adsetName} - Ad`, adset_id: adset.id,
        creative: JSON.stringify({ creative_id: creativeIdToUse }), status: 'ACTIVE'
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

    // Check for failures
    const adErrors = results.ads.filter(a => a.error);
    const adsetErrors = results.adsets.filter(a => a.error);

    const describeError = (e) => {
      if (typeof e === 'object' && e !== null) {
        const msg = e.message || e.error_user_msg || e.error_user_title || '';
        const parts = [msg || JSON.stringify(e)];
        if (msg && e.error_user_msg && e.error_user_msg !== msg) parts.push(e.error_user_msg);
        else if (msg && e.error_user_title && e.error_user_title !== msg) parts.push(e.error_user_title);
        if (e.error_subcode) parts.push(`(subcode: ${e.error_subcode})`);
        if (e.code) parts.push(`(code: ${e.code})`);
        if (e._debug) parts.push(`[ig_user: ${e._debug.ig_user_id_used} (${e._debug.ig_actor_source}), media: ${e._debug.ig_media_id_used}]`);
        return parts.join(' — ');
      }
      return String(e || 'Unknown error');
    };

    if (adErrors.length > 0 || results.ads.length === 0) {
      const errorDetails = adErrors.map(a => describeError(a.error));
      return res.status(400).json({
        status: 'partial_failure',
        error: `Campaign created but ad creation failed: ${errorDetails.join('; ')}`,
        data: results,
      });
    }

    if (adsetErrors.length > 0) {
      const errorDetails = adsetErrors.map(a => describeError(a.error));
      return res.status(400).json({
        status: 'partial_failure',
        error: `Campaign created but ad set creation failed: ${errorDetails.join('; ')}`,
        data: results,
      });
    }

    res.status(200).json({ status: 'created', data: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Main handler: route YouTube vs Meta based on request body ───
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Route based on presence of video_id (YouTube) vs object_story_id/ig_media_id (Meta)
  if (req.body && req.body.video_id) {
    return launchYouTube(req, res);
  } else {
    return launchMeta(req, res);
  }
};
