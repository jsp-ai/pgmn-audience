const {
  googleAdsMutate,
  isGoogleAdsConfigured,
  formatDateForGoogle,
  GEO_TARGET_CONSTANTS,
  GOOGLE_ADS_CUSTOMER_ID,
} = require('../lib/google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    // Using negative IDs as temporary references within the mutate batch
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
            // Views: maximize clicks to drive video traffic; Subscribers: maximize conversions toward subscription goals
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
        // Second Ad Group
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
        // Age targeting for second ad group (25-44)
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
        // Duplicate ad in second ad group
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
      // Google Ads API error
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
    const results = result.mutateOperationResponses || [];
    const campaignResult = results.find(r => r.campaignResult);
    const adGroupResults = results.filter(r => r.adGroupResult);
    const adResults = results.filter(r => r.adGroupAdResult);

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
};
