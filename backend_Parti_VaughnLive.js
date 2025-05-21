const express = require('express');
const axios = require('axios');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// --- Logger Setup ---
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level.toUpperCase()}: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// --- Constants ---
const USER_IDS_TO_CHECK = [348242, 464860, 465731, 463000, 350101, 352176, 349100, 351548, 352357, 352605, 352497, 353535, 351153, 351215, 350459, 352690, 352945];
const BASE_LIVESTREAM_URL = 'https://api-backend.parti.com/parti_v2/profile/get_livestream_channel_info/';
const BASE_PROFILE_URL = 'https://api-backend.parti.com/parti_v2/profile/user_profile/';
const BASE_RECENT_URL = 'https://api-backend.parti.com/parti_v2/profile/user_profile_feed/';
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const VAUGHN_USERNAMES = ['ghost', 'onlyusemehouse'];
const VAUGHN_API_URL = 'https://api.vaughnsoft.net/v1/stream/vl/';

// --- Helper Functions ---

function getRelativeTime(epochTs) {
  if (typeof epochTs !== 'number') return 'Invalid timestamp';
  const now = Date.now() / 1000;
  const diff = now - epochTs;

  if (diff < 0) return 'Future date';
  if (diff < 60) return `${Math.floor(diff)} seconds ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 31104000) return `${Math.floor(diff / 2592000)} months ago`;
  return `${Math.floor(diff / 31104000)} years ago`;
}

async function getApiData(url, identifier, dataType) {
  try {
    const response = await axios.get(url, { headers: REQUEST_HEADERS, timeout: 10000 });
    return [response.data, null];
  } catch (error) {
    let msg;
    if (error.response) {
      msg = `${dataType} HTTP Error ${error.response.status}`;
    } else if (error.code === 'ECONNABORTED') {
      msg = `Timeout fetching ${dataType}`;
    } else if (error.request) {
      msg = `No response received for ${dataType}`;
    } else {
      msg = `Request Error for ${dataType}: ${error.message}`;
    }
    logger.error(`Error fetching ${dataType} for ${identifier}: ${msg}`);
    return [null, msg];
  }
}

async function fetchPartiUserData(userId) {
  const livestreamUrl = `${BASE_LIVESTREAM_URL}${userId}`;
  const profileUrl = `${BASE_PROFILE_URL}${userId}`;
  const recentFeedUrl = `${BASE_RECENT_URL}${userId}?&limit=5`;

  const [
    [livestreamData, liveError],
    [profileData, profileError]
  ] = await Promise.all([
    getApiData(livestreamUrl, userId, 'Livestream'),
    getApiData(profileUrl, userId, 'Profile')
  ]);

  let userName = 'N/A';
  let avatarLink = null;
  let socialMedia = null;
  let socialUsername = null;
  let creatorUrl = null;
  const errorMessages = [];

  if (liveError) errorMessages.push(liveError);
  if (profileError) errorMessages.push(profileError);

  if (profileData) {
    userName = profileData.user_name || 'N/A';
    avatarLink = profileData.avatar_link || null;
    socialMedia = profileData.social_media || null;
    socialUsername = profileData.social_username || null;
    if (socialMedia && socialUsername) {
      creatorUrl = `https://parti.com/creator/${socialMedia}/${socialUsername}`;
    }
  } else {
    logger.warn(`Could not fetch profile for Parti user ${userId}. Some info will be missing.`);
  }

  const userOutput = {
    platform: 'parti',
    user_id: userId,
    user_name: userName,
    avatar_link: avatarLink,
    social_media: socialMedia,
    social_username: socialUsername,
    creator_url: creatorUrl,
    is_live: false
  };

  if (livestreamData?.is_streaming_live_now) {
    const channelInfo = livestreamData.channel_info || {};
    const streamInfo = channelInfo.stream || {};
    const viewerCount = streamInfo.viewer_count;
    const eventName = (channelInfo.livestream_event_info || {}).event_name;

    Object.assign(userOutput, {
      is_live: true,
      viewer_count: viewerCount,
      event_name: eventName
    });
  } else {
    userOutput.is_live = false;
    const [recentData, recentError] = await getApiData(recentFeedUrl, userId, 'Recent Feed');
    if (recentError) errorMessages.push(recentError);

    if (Array.isArray(recentData) && recentData.length > 0) {
      const createdAt = recentData[0].created_at;
      if (typeof createdAt === 'number') {
        userOutput.last_broadcast = getRelativeTime(createdAt);
        userOutput._last_broadcast_ts = createdAt;
      } else {
        logger.warn(`Invalid or missing 'created_at' in recent feed for Parti user ${userId}`);
      }
    } else {
      logger.info(`No recent feed data found to determine last broadcast for offline Parti user ${userId}`);
    }
  }

  if (errorMessages.length > 0) {
    userOutput.error_details = errorMessages.join('; ');
  }

  return userOutput;
}
/**
 * Fetches stream data for a VaughnLive user.
 * @param {string} username - The VaughnLive username.
 * @returns {Promise<object|null>} - A promise resolving to the stream data object or null on error.
 */
async function fetchVaughnStreamData(username) {
  try {
    const res = await axios.get(`${VAUGHN_API_URL}${username}`, { timeout: 10000 });
    const data = res.data;

    // Basic structure common to online/offline
    const baseOutput = {
      platform: 'vaughn',
      username: data.username || username,
      profile_img: data.profile_img,
      online: data.live
    };

    if (data.live) {
      // User is online
      return {
        ...baseOutput,
        status_msg: Buffer.from(data.status_msg || '', 'base64').toString('utf-8'),
        viewers: String(data.viewers || 0)
      };
    } else {
      // User is offline
      const lastEpoch = Number(data.lastlive) || 0;
      return {
        ...baseOutput,
        lastlive_epoch: lastEpoch,
        last_live_relative: lastEpoch ? getRelativeTime(lastEpoch) : 'Unknown'
      };
    }
  } catch (err) {
    logger.error(`Vaughn API error fetching data for ${username}: ${err.message}`);
    return {
      platform: 'vaughn',
      username: username,
      online: false,
      error_details: `Vaughn API Error: ${err.message}`
    };
  }
}


async function fetchAllStreamData() {
  const partiData = await Promise.all(USER_IDS_TO_CHECK.map(fetchPartiUserData));
  const vaughnData = await Promise.all(VAUGHN_USERNAMES.map(fetchVaughnStreamData));
  const allData = [...partiData, ...vaughnData].filter(Boolean);

  allData.sort((a, b) => {
    const isAOnline = a.is_live || a.online;
    const isBOnline = b.is_live || b.online;

    if (isAOnline && !isBOnline) return -1;
    if (!isAOnline && isBOnline) return 1;

    if (isAOnline && isBOnline) {
      const viewersA = parseInt(a.viewer_count || a.viewers || 0);
      const viewersB = parseInt(b.viewer_count || b.viewers || 0);
      return viewersB - viewersA;
    }

    const lastLiveA = a._last_broadcast_ts || a.lastlive_epoch || 0;
    const lastLiveB = b._last_broadcast_ts || b.lastlive_epoch || 0;
    return lastLiveB - lastLiveA;
  });

  allData.forEach(user => {
    delete user._last_broadcast_ts;
  });

  return allData;
}

async function updateDataFile() {
  logger.info('Starting data update...');
  try {
    const sortedData = await fetchAllStreamData();
    const filePath = path.join(__dirname, 'data.json');
    fs.writeFileSync(filePath, JSON.stringify(sortedData, null, 2));
    logger.info(`data.json updated successfully with ${sortedData.length} entries.`);
  } catch (err) {
    logger.error(`Failed to update data.json: ${err.message}`, err.stack);
  }
}

cron.schedule('*/1 * * * *', () => {
  logger.info('Running scheduled data update...');
  updateDataFile();
});

logger.info('Performing initial data fetch and write...');
updateDataFile();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  logger.info('Received request for /api/data');
  try {
    const filePath = path.join(__dirname, 'data.json');
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      logger.error('data.json not found for /api/data request.');
      res.status(404).json({ error: 'Data file not found. Please wait for the next update.' });
    }
  } catch (err) {
    logger.error(`API endpoint /api/data failed: ${err.message}`, err.stack);
    res.status(500).json({ error: 'Failed to retrieve stream data' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  logger.info(`Server is running and listening on http://localhost:${PORT}`);
});
