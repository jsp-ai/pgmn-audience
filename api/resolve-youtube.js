const { youtubeGet, YOUTUBE_DATA_API_KEY } = require('../lib/google');

// Extract YouTube video ID from various URL formats
function extractVideoId(url) {
  if (!url) return null;
  // youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/youtube\.com\/watch\?.*v=([A-Za-z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  // youtube.com/shorts/VIDEO_ID
  const shortsMatch = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];
  // youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  // youtube.com/live/VIDEO_ID
  const liveMatch = url.match(/youtube\.com\/live\/([A-Za-z0-9_-]{11})/);
  if (liveMatch) return liveMatch[1];
  // youtube.com/embed/VIDEO_ID
  const embedMatch = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = req.query.url || '';
    const videoId = extractVideoId(url);

    if (!videoId) {
      return res.status(200).json({
        resolved: false,
        error: 'Could not extract YouTube video ID from URL',
      });
    }

    // If no API key configured, return basic resolution with just the video ID
    if (!YOUTUBE_DATA_API_KEY) {
      return res.status(200).json({
        resolved: true,
        platform: 'youtube',
        video_id: videoId,
        title: null,
        description: null,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        channel: null,
        channel_id: null,
        duration: null,
        content_type: url.includes('/shorts/') ? 'short' : 'video',
        source: 'url_parse',
        warnings: ['YouTube Data API key not configured — using basic resolution'],
      });
    }

    // Fetch video metadata from YouTube Data API v3
    const data = await youtubeGet('videos', {
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });

    if (!data.items || data.items.length === 0) {
      return res.status(200).json({
        resolved: false,
        error: 'Video not found on YouTube. It may be private or deleted.',
      });
    }

    const video = data.items[0];
    const snippet = video.snippet || {};
    const contentDetails = video.contentDetails || {};
    const stats = video.statistics || {};

    // Determine content type
    const isShort = url.includes('/shorts/') ||
      (contentDetails.duration && parseDuration(contentDetails.duration) <= 60);

    return res.status(200).json({
      resolved: true,
      platform: 'youtube',
      video_id: videoId,
      title: snippet.title || null,
      description: snippet.description || null,
      thumbnail: getBestThumbnail(snippet.thumbnails),
      channel: snippet.channelTitle || null,
      channel_id: snippet.channelId || null,
      duration: contentDetails.duration || null,
      duration_seconds: contentDetails.duration ? parseDuration(contentDetails.duration) : null,
      view_count: parseInt(stats.viewCount || '0'),
      content_type: isShort ? 'short' : 'video',
      source: 'youtube_data_api',
      warnings: [],
    });

  } catch (err) {
    return res.status(500).json({
      resolved: false,
      error: `YouTube resolution failed: ${err.message}`,
    });
  }
};

// Parse ISO 8601 duration (PT3M32S) to seconds
function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  return hours * 3600 + minutes * 60 + seconds;
}

// Get the best available thumbnail URL
function getBestThumbnail(thumbnails) {
  if (!thumbnails) return null;
  return (thumbnails.maxres && thumbnails.maxres.url) ||
    (thumbnails.standard && thumbnails.standard.url) ||
    (thumbnails.high && thumbnails.high.url) ||
    (thumbnails.medium && thumbnails.medium.url) ||
    (thumbnails.default && thumbnails.default.url) ||
    null;
}

// Export extractVideoId for use in server.js
module.exports.extractVideoId = extractVideoId;
