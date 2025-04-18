/**
 * Video Clip Website Backend
 * - Tracks and clips from YouTube, Kick.com, and Parti.com livestreams
 * - Supports clips up to 4 minutes with custom time frames
 * - Includes preview functionality and auto-upload to pomf.lain.la
 */

// Required dependencies
const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const dotenv = require('dotenv');
const winston = require('winston');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// Setup puppeteer with privacy enhancing plugins
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()} - ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5 
    })
  ]
});

// Initialize express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create directories if they don't exist
const tempDir = path.join(__dirname, 'temp');
const clipsDir = path.join(__dirname, 'public', 'clips');
const dataDir = path.join(__dirname, 'data');
const thumbnailsDir = path.join(__dirname, 'public', 'thumbnails');

fs.ensureDirSync(tempDir);
fs.ensureDirSync(clipsDir);
fs.ensureDirSync(dataDir);
fs.ensureDirSync(thumbnailsDir);

// Streamer configurations
const config = {
  refreshInterval: process.env.REFRESH_INTERVAL || 60, // seconds
  maxClipDuration: process.env.MAX_CLIP_DURATION || 240, // seconds (4 minutes)
  uploadEndpoint: 'https://pomf.lain.la/upload.php',
  platforms: {
    kick: {
      enabled: true,
      usernames: [
        "waxiest", "loulz", "ac7ionman", "asianandy", "lettyvision", "iholly", 
        "adrianahlee", "garydavid", "bennymack", "mikesmallsjr", "crazytawn", 
        "jandro", "n3on", "Deepak", "mskat", "edboys", "floridaboymma", 
        "dtanmanb", "iduncle", "cristravels", "burgerplanet", "tazo", "billyjohn",
        "mando", "iceposeidon", "nedx", "kevtv", "andy", "bongbong_irl", 
        "hamptonbrando", "ddurantv", "boneclinks", "fousey"
      ],
      dataFile: path.join(dataDir, 'kick_streamers.json')
    },
    youtube: {
      enabled: true,
      channelIds: [
        "UCueVr5KzwKPzTcFjcDUfMMw",
        "UCUNfKvI45t9zMsuLzbqigqA",
        "UCUNHxLIQ1AgtYCTGXxBvX2w",
        "UCjYKsjt-7EDU78KEcVbhYnQ"
      ],
      dataFile: path.join(dataDir, 'youtube_streamers.json')
    },
    twitch: {
      enabled: true,
      clientId: process.env.TWITCH_CLIENT_ID,
      clientSecret: process.env.TWITCH_CLIENT_SECRET,
      usernames: [
        "dohertyjack", "boyflyirl", "jewelrancidlive", "dankquan", 
        "vpgloves", "kaicenat", "gcwrestling", "trumporbiden2028"
      ],
      dataFile: path.join(dataDir, 'twitch_streamers.json')
    },
    parti: {
      enabled: true,
      userIds: [348242, 464860, 465731, 463000, 350101, 352438],
      dataFile: path.join(dataDir, 'parti_streamers.json')
    }
  }
};

// Active jobs tracking
const activeJobs = new Map();
let browser = null;

/**
 * Browser Management and Utility Functions
 */

// Initialize browser
async function initBrowser() {
  if (!browser || !browser.isConnected()) {
    logger.info('Initializing browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
      ignoreHTTPSErrors: true
    });
    logger.info('Browser initialized.');
  }
  return browser;
}

// Close browser
async function closeBrowser() {
  if (browser && browser.isConnected()) {
    await browser.close();
    browser = null;
    logger.info('Browser closed.');
  }
}

// Parse viewer count (handles formats like "1.2k" or "1m")
function parseViewerCount(text) {
  try {
    if (!text) return 0;
    
    text = text.toLowerCase().replace(/,/g, '').trim();
    
    if (text.includes('k')) {
      return Math.floor(parseFloat(text.replace('k', '')) * 1000);
    } else if (text.includes('m')) {
      return Math.floor(parseFloat(text.replace('m', '')) * 1000000);
    }
    
    return parseInt(text, 10) || 0;
  } catch (error) {
    logger.error(`Error parsing viewer count: ${error.message}`);
    return 0;
  }
}

// Parse last broadcast time to seconds
function parseLastBroadcastTime(text) {
  if (!text || text.toLowerCase() === 'not available') {
    return Number.POSITIVE_INFINITY;
  }
  
  const timeMap = {
    'second': 1,
    'minute': 60,
    'hour': 3600,
    'day': 86400,
    'week': 604800,
    'month': 2592000
  };
  
  try {
    // Simple regex-based parser
    const match = text.toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago/);
    
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      return value * (timeMap[unit] || 9999999);
    }
    
    // Try to parse date strings
    if (text.match(/\d{4}-\d{2}-\d{2}/)) {
      const date = new Date(text);
      if (!isNaN(date.getTime())) {
        return (new Date().getTime() - date.getTime()) / 1000;
      }
    }
    
    return Number.POSITIVE_INFINITY;
  } catch (error) {
    logger.error(`Error parsing last broadcast time: ${error.message}`);
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Kick.com Functions
 */

async function fetchKickStreamers() {
  logger.info('Fetching Kick streamers...');
  
  const results = [];
  
  try {
    const browser = await initBrowser();
    const page = await browser.newPage();
    
    // Set custom headers
    await page.setExtraHTTPHeaders({
      'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      'x-client-token': 'e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823'
    });
    
    for (const username of config.platforms.kick.usernames) {
      logger.info(`Checking Kick streamer: ${username}`);
      
      try {
        const url = `https://kick.com/${username}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Check if page loaded properly
        const channelContent = await page.$('#channel-content');
        if (!channelContent) {
          logger.warn(`Failed to load channel content for ${username}`);
          continue;
        }
        
        // Check live status
        let isLive = false;
        try {
          const liveBadgeSelector = '#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.max-w-full.shrink.grow-0.flex-row.gap-2.overflow-hidden.lg\\:gap-4 > div.shrink-0 > button > div > span';
          
          const liveBadgeElement = await page.$(liveBadgeSelector);
          if (liveBadgeElement) {
            const liveBadgeText = await page.evaluate(el => el.textContent.toLowerCase(), liveBadgeElement);
            isLive = liveBadgeText.includes('live');
          }
        } catch (error) {
          logger.error(`Error checking live status for ${username}: ${error.message}`);
        }
        
        // Get username from display
        let displayName = username;
        try {
          const nameElem = await page.$('#channel-username');
          if (nameElem) {
            displayName = await page.evaluate(el => el.textContent.trim(), nameElem);
          }
        } catch (error) {
          logger.error(`Error getting display name for ${username}: ${error.message}`);
        }
        
        // Get profile photo
        let profilePhoto = null;
        try {
          if (isLive) {
            const avatarElem = await page.$('#channel-avatar img');
            if (avatarElem) {
              profilePhoto = await page.evaluate(el => el.getAttribute('src'), avatarElem);
            }
          } else {
            const avatarElem = await page.$('#channel-content img.rounded-full');
            if (avatarElem) {
              profilePhoto = await page.evaluate(el => el.getAttribute('src'), avatarElem);
            }
          }
        } catch (error) {
          logger.error(`Error getting profile photo for ${username}: ${error.message}`);
        }
        
        // Build data object
        let data = {
          username: displayName,
          profile_photo: profilePhoto || "Not Found",
          platform: "kick"
        };
        
        // If live, get title and viewer count
        if (isLive) {
          try {
            const titleSelector = '#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.max-w-full.shrink.grow-0.flex-row.gap-2.overflow-hidden.lg\\:gap-4 > div.flex.max-w-full.grow.flex-col.gap-1.overflow-hidden > div.flex.min-w-0.max-w-full.shrink.gap-1.overflow-hidden > span';
            const viewersSelector = '#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.shrink-0.flex-col.items-end.gap-2 > div.flex.items-center.gap-2.self-end.py-0\\.5 > div > span > span.relative.tabular-nums';
            
            const titleElem = await page.$(titleSelector);
            const viewersElem = await page.$(viewersSelector);
            
            let title = 'N/A';
            let viewerCount = 0;
            
            if (titleElem) {
              title = await page.evaluate(el => el.textContent.trim(), titleElem);
            }
            
            if (viewersElem) {
              const viewersText = await page.evaluate(el => el.textContent.trim(), viewersElem);
              viewerCount = parseViewerCount(viewersText);
            }
            
            data.title = title;
            data.viewer_count = viewerCount;
            data.status = "live";
            
            // Get stream HLS URL for potential clipping
            let streamUrl = null;
            try {
              page.on('response', response => {
                const url = response.url();
                if (url.includes('.m3u8')) {
                  streamUrl = url;
                }
              });
              
              // Refresh the video element to trigger HLS URL request
              await page.evaluate(() => {
                const videoElement = document.querySelector('video');
                if (videoElement) {
                  videoElement.currentTime = 0;
                }
              });
              
              // Wait a bit for the request to happen
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              if (streamUrl) {
                data.stream_url = streamUrl;
              }
            } catch (error) {
              logger.error(`Error extracting stream URL for ${username}: ${error.message}`);
            }
          } catch (error) {
            logger.error(`Error getting title/viewers for ${username}: ${error.message}`);
            data.title = 'N/A';
            data.viewer_count = 0;
            data.status = "live";
          }
        } else {
          // Get last broadcast time if offline
          try {
            const lastBroadcastSelector = '#channel-content > div.flex.w-full.min-w-0.max-w-full.flex-col.justify-between.gap-3.pb-3.pt-2.lg\\:flex-row.lg\\:gap-12.lg\\:pb-0.lg\\:pt-0 > div.flex.max-w-full.shrink.grow-0.flex-row.gap-2.overflow-hidden.lg\\:gap-4 > div.flex.max-w-full.grow.flex-col.gap-1.overflow-hidden > span:nth-child(3) > span';
            
            const lastBroadcastElem = await page.$(lastBroadcastSelector);
            if (lastBroadcastElem) {
              const lastBroadcast = await page.evaluate(el => el.textContent.trim(), lastBroadcastElem);
              data.last_broadcast = lastBroadcast;
            } else {
              data.last_broadcast = 'Not Available';
            }
            data.status = "offline";
          } catch (error) {
            logger.error(`Error getting last broadcast for ${username}: ${error.message}`);
            data.last_broadcast = 'Not Available';
            data.status = "offline";
          }
        }
        
        results.push(data);
        
      } catch (error) {
        logger.error(`Error processing Kick streamer ${username}: ${error.message}`);
        continue;
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Sort results
    const sortedResults = results.sort((a, b) => {
      // Live streams first, sorted by viewer count
      if (a.status === 'live' && b.status === 'live') {
        return b.viewer_count - a.viewer_count;
      }
      // If only one is live, it goes first
      if (a.status === 'live') return -1;
      if (b.status === 'live') return 1;
      
      // Both offline, sort by last broadcast time
      return parseLastBroadcastTime(a.last_broadcast) - parseLastBroadcastTime(b.last_broadcast);
    });
    
    // Save to file
    fs.writeJsonSync(config.platforms.kick.dataFile, sortedResults, { spaces: 2 });
    logger.info(`Saved ${sortedResults.length} Kick streamers to ${config.platforms.kick.dataFile}`);
    
    return sortedResults;
    
  } catch (error) {
    logger.error(`Error fetching Kick streamers: ${error.message}`);
    return [];
  }
}

/**
 * YouTube Functions
 */

async function fetchYoutubeStreamers() {
  logger.info('Fetching YouTube streamers...');
  
  const liveStreams = [];
  const offlineStreams = [];
  
  try {
    const browser = await initBrowser();
    
    for (const channelId of config.platforms.youtube.channelIds) {
      logger.info(`Checking YouTube channel: ${channelId}`);
      
      try {
        const page = await browser.newPage();
        
        // Check if channel is live
        const liveUrl = `https://www.youtube.com/channel/${channelId}/live`;
        await page.goto(liveUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait a bit for dynamic content
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check if we have a viewer count element (indicating live status)
        const viewerCountElement = await page.$('#view-count > yt-animated-rolling-number');
        
        if (viewerCountElement) {
          // Channel is live
          let viewerCount = 0;
          let username = channelId;
          let profilePhoto = '';
          let title = '';
          
          try {
            // Get viewer count
            const viewerText = await page.evaluate(el => el.textContent, viewerCountElement);
            viewerCount = parseViewerCount(viewerText);
            
            // Get username
            const usernameElement = await page.$('#text > a');
            if (usernameElement) {
              username = await page.evaluate(el => el.textContent, usernameElement);
            }
            
            // Get profile photo
            const profileElement = await page.$('#img');
            if (profileElement) {
              profilePhoto = await page.evaluate(el => el.getAttribute('src'), profileElement);
            }
            
            // Get title
            const titleElement = await page.$('#title > h1 > yt-formatted-string');
            if (titleElement) {
              title = await page.evaluate(el => el.textContent, titleElement);
            }
            
            // Get stream URL
            let streamUrl = null;
            try {
              page.on('response', response => {
                const url = response.url();
                if (url.includes('.m3u8')) {
                  streamUrl = url;
                }
              });
              
              // Refresh video playback to trigger HLS URL request
              await page.evaluate(() => {
                const videoElement = document.querySelector('video');
                if (videoElement) {
                  videoElement.currentTime = 0;
                }
              });
              
              // Wait a bit for the request to happen
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
              logger.error(`Error extracting stream URL for YouTube channel ${channelId}: ${error.message}`);
            }
            
            liveStreams.push({
              channel_id: channelId,
              status: 'live',
              username,
              profile_photo: profilePhoto,
              viewer_count: viewerCount,
              title,
              stream_url: streamUrl,
              platform: "youtube"
            });
          } catch (error) {
            logger.error(`Error extracting live data for YouTube channel ${channelId}: ${error.message}`);
          }
        } else {
          // Channel is offline, get channel info
          await page.goto(`https://www.youtube.com/channel/${channelId}`, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          let username = 'Unknown';
          let profilePhoto = '';
          let lastBroadcast = 'Unavailable';
          
          try {
            // Get username
            const usernameElement = await page.$('#page-header h1 span');
            if (usernameElement) {
              username = await page.evaluate(el => el.textContent, usernameElement);
            }
            
            // Get profile photo
            const profileElement = await page.$('#page-header img');
            if (profileElement) {
              profilePhoto = await page.evaluate(el => el.getAttribute('src'), profileElement);
            }
            
            // Try to get last broadcast time
            const lastBroadcastElement = await page.$('#metadata-line > span:nth-child(4)');
            if (lastBroadcastElement) {
              lastBroadcast = await page.evaluate(el => el.textContent, lastBroadcastElement);
            }
          } catch (error) {
            logger.error(`Error extracting offline data for YouTube channel ${channelId}: ${error.message}`);
          }
          
          offlineStreams.push({
            channel_id: channelId,
            status: 'offline',
            username,
            profile_photo: profilePhoto,
            last_broadcast: lastBroadcast,
            platform: "youtube"
          });
        }
        
        await page.close();
        
      } catch (error) {
        logger.error(`Error processing YouTube channel ${channelId}: ${error.message}`);
        continue;
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Sort live streams by viewer count
    liveStreams.sort((a, b) => b.viewer_count - a.viewer_count);
    
    // Combine results
    const result = {
      live_streams: liveStreams,
      offline_streams: offlineStreams
    };
    
    // Save to file
    fs.writeJsonSync(config.platforms.youtube.dataFile, result, { spaces: 2 });
    logger.info(`Saved ${liveStreams.length} live and ${offlineStreams.length} offline YouTube streamers`);
    
    return result;
    
  } catch (error) {
    logger.error(`Error fetching YouTube streamers: ${error.message}`);
    return { live_streams: [], offline_streams: [] };
  }
}

/**
 * Twitch Functions
 */

async function fetchTwitchStreamers() {
  logger.info('Fetching Twitch streamers...');
  
  if (!config.platforms.twitch.clientId || !config.platforms.twitch.clientSecret) {
    logger.error('Missing Twitch API credentials');
    return { live_streamers: [], offline_streamers: [] };
  }
  
  try {
    // Get access token
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: config.platforms.twitch.clientId,
        client_secret: config.platforms.twitch.clientSecret,
        grant_type: 'client_credentials'
      }
    });
    
    const accessToken = tokenResponse.data.access_token;
    
    if (!accessToken) {
      logger.error('Failed to get Twitch access token');
      return { live_streamers: [], offline_streamers: [] };
    }
    
    // Get user info
    const userParams = new URLSearchParams();
    config.platforms.twitch.usernames.forEach(username => {
      userParams.append('login', username);
    });
    
    const userResponse = await axios.get(`https://api.twitch.tv/helix/users?${userParams.toString()}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': config.platforms.twitch.clientId
      }
    });
    
    const userData = userResponse.data.data;
    
    if (!userData || userData.length === 0) {
      logger.error('No Twitch user data returned');
      return { live_streamers: [], offline_streamers: [] };
    }
    
    // Map user data by id and username
    const userDataMap = {};
    for (const user of userData) {
      userDataMap[user.id] = {
        username: user.login,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url
      };
    }
    
    // Get user IDs
    const userIds = userData.map(user => user.id);
    
    // Get live streams
    const streamsParams = new URLSearchParams();
    userIds.forEach(id => {
      streamsParams.append('user_id', id);
    });
    
    const streamsResponse = await axios.get(`https://api.twitch.tv/helix/streams?${streamsParams.toString()}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': config.platforms.twitch.clientId
      }
    });
    
    const streamsData = streamsResponse.data.data;
    
    // Build live streamers list
    const liveStreamers = [];
    const liveUserIds = new Set(streamsData.map(stream => stream.user_id));
    
    for (const stream of streamsData) {
      const userId = stream.user_id;
      const userData = userDataMap[userId];
      
      if (userData) {
        // Get stream URL - need to use browser for this
        let streamUrl = null;
        try {
          const browser = await initBrowser();
          const page = await browser.newPage();
          
          await page.goto(`https://www.twitch.tv/${userData.username}`, { waitUntil: 'networkidle2', timeout: 30000 });
          
          page.on('response', response => {
            const url = response.url();
            if (url.includes('.m3u8')) {
              streamUrl = url;
            }
          });
          
          // Wait a bit for the request to happen
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          await page.close();
        } catch (error) {
          logger.error(`Error extracting stream URL for Twitch user ${userData.username}: ${error.message}`);
        }
        
        liveStreamers.push({
          profile_photo: userData.profile_image_url,
          username: userData.username,
          display_name: userData.display_name,
          title: stream.title,
          viewer_count: stream.viewer_count,
          stream_url: streamUrl,
          platform: "twitch"
        });
      }
    }
    
    // Sort live streamers by viewer count
    liveStreamers.sort((a, b) => b.viewer_count - a.viewer_count);
    
    // Build offline streamers list
    const offlineStreamers = [];
    
    for (const userId in userDataMap) {
      if (!liveUserIds.has(userId)) {
        const userData = userDataMap[userId];
        
        // Get last broadcast for this user
        try {
          const videosResponse = await axios.get(`https://api.twitch.tv/helix/videos`, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Client-Id': config.platforms.twitch.clientId
            },
            params: {
              user_id: userId,
              first: 1,
              type: 'archive'
            }
          });
          
          const videos = videosResponse.data.data;
          
          const offlineData = {
            profile_photo: userData.profile_image_url,
            username: userData.username,
            display_name: userData.display_name,
            platform: "twitch"
          };
          
          if (videos && videos.length > 0) {
            const lastVideo = videos[0];
            const createdAt = new Date(lastVideo.created_at);
            offlineData.last_stream_time = createdAt.toISOString();
          }
          
          offlineStreamers.push(offlineData);
          
        } catch (error) {
          logger.error(`Error getting videos for Twitch user ${userId}: ${error.message}`);
          
          offlineStreamers.push({
            profile_photo: userData.profile_image_url,
            username: userData.username,
            display_name: userData.display_name,
            platform: "twitch"
          });
        }
      }
    }
    
    // Sort offline streamers by last stream time
    offlineStreamers.sort((a, b) => {
      if (!a.last_stream_time) return 1;
      if (!b.last_stream_time) return -1;
      return new Date(b.last_stream_time) - new Date(a.last_stream_time);
    });
    
    const result = {
      live_streamers: liveStreamers,
      offline_streamers: offlineStreamers
    };
    
    // Save to file
    fs.writeJsonSync(config.platforms.twitch.dataFile, result, { spaces: 2 });
    logger.info(`Saved ${liveStreamers.length} live and ${offlineStreamers.length} offline Twitch streamers`);
    
    return result;
    
  } catch (error) {
    logger.error(`Error fetching Twitch streamers: ${error.message}`);
    return { live_streamers: [], offline_streamers: [] };
  }
}

/**
 * Parti.com Functions
 */

async function fetchPartiStreamers() {
  logger.info('Fetching Parti streamers...');
  
  const results = [];
  
  try {
    // Set headers
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
    
    for (const userId of config.platforms.parti.userIds) {
      logger.info(`Checking Parti user: ${userId}`);
      
      try {
        // Get livestream info
        const livestreamUrl = `https://api-backend.parti.com/parti_v2/profile/get_livestream_channel_info/${userId}`;
        const livestreamResponse = await axios.get(livestreamUrl, { headers });
        
        // Get profile info
        const profileUrl = `https://api-backend.parti.com/parti_v2/profile/user_profile/${userId}`;
        const profileResponse = await axios.get(profileUrl, { headers });
        
        let isLive = false;
        let viewerCount = null;
        let eventName = null;
        let userName = null;
        let avatarLink = null;
        
        // Process livestream data
        if (livestreamResponse.data) {
          isLive = livestreamResponse.data.is_streaming_live_now === true;
          
          if (isLive) {
            const channelInfo = livestreamResponse.data.channel_info;
            if (channelInfo && typeof channelInfo === 'object') {
              const streamInfo = channelInfo.stream;
              if (streamInfo && typeof streamInfo === 'object') {
                viewerCount = streamInfo.viewer_count;
              }
              
              const livestreamEventInfo = channelInfo.livestream_event_info;
              if (livestreamEventInfo && typeof livestreamEventInfo === 'object') {
                eventName = livestreamEventInfo.event_name;
              }
            }
          }
        }
        
        // Process profile data
        if (profileResponse.data) {
          userName = profileResponse.data.user_name;
          avatarLink = profileResponse.data.avatar_link;
        }
        
        // Construct output
        const userOutput = {
          user_id: userId,
          is_live: isLive,
          user_name: userName,
          avatar_link: avatarLink,
          platform: "parti"
        };
        
        if (isLive) {
          userOutput.viewer_count = viewerCount;
          userOutput.event_name = eventName;
          userOutput.status = "live";
          
          // Try to get stream URL using browser
          try {
            const browser = await initBrowser();
            const page = await browser.newPage();
            
            // Navigate to user page
            await page.goto(`https://parti.com/user/${userId}`, { waitUntil: 'networkidle2', timeout: 30000 });
            
            // Wait for video to load
            await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
            
            // Capture m3u8 URLs
            let streamUrl = null;
            page.on('response', (response) => {
              const url = response.url();
              if (url.includes('.m3u8')) {
                streamUrl = url;
              }
            });
            
            // Try to interact with video
            await page.evaluate(() => {
              const videoElement = document.querySelector('video');
              if (videoElement) {
                videoElement.currentTime = 0;
              }
            });
            
            // Wait a bit for potential requests
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            if (streamUrl) {
              userOutput.stream_url = streamUrl;
            }
            
            await page.close();
          } catch (error) {
            logger.error(`Error getting stream URL for Parti user ${userId}: ${error.message}`);
          }
        } else {
          userOutput.status = "offline";
        }
        
        results.push(userOutput);
        
      } catch (error) {
        logger.error(`Error processing Parti user ${userId}: ${error.message}`);
        continue;
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Sort by viewer count
    const sortedResults = results.sort((a, b) => {
      const aCount = (a.is_live && typeof a.viewer_count === 'number') ? a.viewer_count : -1;
      const bCount = (b.is_live && typeof b.viewer_count === 'number') ? b.viewer_count : -1;
      return bCount - aCount;
    });
    
    // Save to file
    fs.writeJsonSync(config.platforms.parti.dataFile, sortedResults, { spaces: 2 });
    logger.info(`Saved ${sortedResults.length} Parti streamers to ${config.platforms.parti.dataFile}`);
    
    return sortedResults;
    
  } catch (error) {
    logger.error(`Error fetching Parti streamers: ${error.message}`);
    return [];
  }
}

/**
 * Combined Functions to Fetch All Streamers
 */

async function fetchAllStreamers() {
  logger.info('Fetching streamers from all platforms...');
  
  const results = {
    kick: [],
    youtube: { live_streams: [], offline_streams: [] },
    twitch: { live_streamers: [], offline_streamers: [] },
    parti: []
  };
  
  // Fetch all platforms in parallel
  const promises = [];
  
  if (config.platforms.kick.enabled) {
    promises.push(
      fetchKickStreamers()
        .then(data => { results.kick = data; })
        .catch(error => { 
          logger.error(`Error in kick fetch: ${error.message}`);
          if (fs.existsSync(config.platforms.kick.dataFile)) {
            results.kick = fs.readJsonSync(config.platforms.kick.dataFile);
          }
        })
    );
  }
  
  if (config.platforms.youtube.enabled) {
    promises.push(
      fetchYoutubeStreamers()
        .then(data => { results.youtube = data; })
        .catch(error => { 
          logger.error(`Error in youtube fetch: ${error.message}`);
          if (fs.existsSync(config.platforms.youtube.dataFile)) {
            results.youtube = fs.readJsonSync(config.platforms.youtube.dataFile);
          }
        })
    );
  }
  
  if (config.platforms.twitch.enabled) {
    promises.push(
      fetchTwitchStreamers()
        .then(data => { results.twitch = data; })
        .catch(error => { 
          logger.error(`Error in twitch fetch: ${error.message}`);
          if (fs.existsSync(config.platforms.twitch.dataFile)) {
            results.twitch = fs.readJsonSync(config.platforms.twitch.dataFile);
          }
        })
    );
  }
  
  if (config.platforms.parti.enabled) {
    promises.push(
      fetchPartiStreamers()
        .then(data => { results.parti = data; })
        .catch(error => { 
          logger.error(`Error in parti fetch: ${error.message}`);
          if (fs.existsSync(config.platforms.parti.dataFile)) {
            results.parti = fs.readJsonSync(config.platforms.parti.dataFile);
          }
        })
    );
  }
  
  // Wait for all promises to resolve
  await Promise.all(promises);
  
  // Return combined results
  return results;
}

// Get all live streamers from all platforms
function getAllLiveStreamers() {
  const allLive = [];
  
  // Load data from files
  try {
    if (fs.existsSync(config.platforms.kick.dataFile)) {
      const kickData = fs.readJsonSync(config.platforms.kick.dataFile);
      kickData.filter(s => s.status === 'live').forEach(s => allLive.push(s));
    }
    
    if (fs.existsSync(config.platforms.youtube.dataFile)) {
      const youtubeData = fs.readJsonSync(config.platforms.youtube.dataFile);
      youtubeData.live_streams.forEach(s => allLive.push(s));
    }
    
    if (fs.existsSync(config.platforms.twitch.dataFile)) {
      const twitchData = fs.readJsonSync(config.platforms.twitch.dataFile);
      twitchData.live_streamers.forEach(s => allLive.push(s));
    }
    
    if (fs.existsSync(config.platforms.parti.dataFile)) {
      const partiData = fs.readJsonSync(config.platforms.parti.dataFile);
      partiData.filter(s => s.is_live || s.status === 'live').forEach(s => allLive.push(s));
    }
  } catch (error) {
    logger.error(`Error getting all live streamers: ${error.message}`);
  }
  
  // Sort by viewer count
  return allLive.sort((a, b) => {
    const aCount = a.viewer_count || 0;
    const bCount = b.viewer_count || 0;
    return bCount - aCount;
  });
}

/**
 * Clipping Functions
 */

// Generate a unique ID for a clip job
function generateClipId() {
  return `clip_${Date.now()}_${uuidv4().substring(0, 8)}`;
}

// Capture stream segment for clipping
async function captureStreamSegment(platform, streamerId, maxDuration = 240) {
  logger.info(`Capturing stream segment for ${platform}:${streamerId} (max ${maxDuration}s)`);
  
  const clipId = generateClipId();
  const outputFile = path.join(tempDir, `${clipId}_buffer.mp4`);
  
  activeJobs.set(clipId, {
    id: clipId,
    platform,
    streamerId,
    status: 'capturing',
    progress: 0,
    outputFile,
    startTime: Date.now()
  });
  
  let streamUrl = null;
  
  try {
    // Get stream URL based on platform
    switch (platform) {
      case 'kick':
        const kickData = fs.readJsonSync(config.platforms.kick.dataFile);
        const kickStreamer = kickData.find(s => s.username.toLowerCase() === streamerId.toLowerCase() && s.status === 'live');
        if (kickStreamer && kickStreamer.stream_url) {
          streamUrl = kickStreamer.stream_url;
        }
        break;
        
      case 'youtube':
        const youtubeData = fs.readJsonSync(config.platforms.youtube.dataFile);
        const youtubeStreamer = youtubeData.live_streams.find(s => 
          s.channel_id === streamerId || s.username.toLowerCase() === streamerId.toLowerCase()
        );
        if (youtubeStreamer && youtubeStreamer.stream_url) {
          streamUrl = youtubeStreamer.stream_url;
        }
        break;
        
      case 'twitch':
        const twitchData = fs.readJsonSync(config.platforms.twitch.dataFile);
        const twitchStreamer = twitchData.live_streamers.find(s => s.username.toLowerCase() === streamerId.toLowerCase());
        if (twitchStreamer && twitchStreamer.stream_url) {
          streamUrl = twitchStreamer.stream_url;
        }
        break;
        
      case 'parti':
        const partiData = fs.readJsonSync(config.platforms.parti.dataFile);
        const partiStreamer = partiData.find(s => 
          s.user_id.toString() === streamerId.toString() || 
          (s.user_name && s.user_name.toLowerCase() === streamerId.toLowerCase())
        );
        if (partiStreamer && partiStreamer.stream_url) {
          streamUrl = partiStreamer.stream_url;
        }
        break;
    }
    
    // If no stream URL found in cached data, try to get it with browser
    if (!streamUrl) {
      streamUrl = await getStreamUrlWithBrowser(platform, streamerId);
    }
    
    if (!streamUrl) {
      throw new Error(`Could not find stream URL for ${platform}:${streamerId}`);
    }
    
    logger.info(`Found stream URL for ${platform}:${streamerId}`);
    
    // Update job status
    const job = activeJobs.get(clipId);
    job.streamUrl = streamUrl;
    activeJobs.set(clipId, job);
    
    // Use FFmpeg to capture segment
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'info',
        '-i', streamUrl,
        '-t', maxDuration.toString(),
        '-c', 'copy',
        '-y',
        outputFile
      ];
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      ffmpegProcess.stdout.on('data', (data) => {
        logger.debug(`FFmpeg stdout: ${data}`);
      });
      
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        logger.debug(`FFmpeg stderr: ${output}`);
        
        // Try to parse progress
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+.\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const seconds = parseFloat(timeMatch[3]);
          
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          const progressPercent = Math.min(100, (totalSeconds / maxDuration) * 100);
          
          // Update job progress
          const job = activeJobs.get(clipId);
          if (job) {
            job.progress = progressPercent;
            activeJobs.set(clipId, job);
          }
        }
      });
      
      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          logger.info(`Successfully captured stream segment for ${platform}:${streamerId}`);
          
          // Update job status
          const job = activeJobs.get(clipId);
          job.status = 'captured';
          job.progress = 100;
          activeJobs.set(clipId, job);
          
          resolve({
            clipId,
            outputFile,
            duration: maxDuration
          });
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        reject(new Error(`FFmpeg error: ${error.message}`));
      });
    });
    
  } catch (error) {
    logger.error(`Error capturing stream segment: ${error.message}`);
    
    // Update job status
    const job = activeJobs.get(clipId);
    if (job) {
      job.status = 'error';
      job.error = error.message;
      activeJobs.set(clipId, job);
    }
    
    throw error;
  }
}

// Get stream URL using browser
async function getStreamUrlWithBrowser(platform, streamerId) {
  logger.info(`Getting stream URL for ${platform}:${streamerId} using browser`);
  
  try {
    const browser = await initBrowser();
    const page = await browser.newPage();
    
    // Navigate to the appropriate URL based on platform
    let url;
    switch (platform) {
      case 'kick':
        url = `https://kick.com/${streamerId}`;
        break;
      case 'youtube':
        // Check if it's a channel ID or username
        if (streamerId.startsWith('UC')) {
          url = `https://www.youtube.com/channel/${streamerId}/live`;
        } else {
          url = `https://www.youtube.com/c/${streamerId}/live`;
        }
        break;
      case 'twitch':
        url = `https://www.twitch.tv/${streamerId}`;
        break;
      case 'parti':
        url = `https://parti.com/user/${streamerId}`;
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
    
    // Navigate to page
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for video to load
    await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
    
    // Listen for network requests to find HLS stream
    let streamUrl = null;
    page.on('response', response => {
      const responseUrl = response.url();
      if (responseUrl.includes('.m3u8')) {
        streamUrl = responseUrl;
      }
    });
    
    // Interact with video to trigger network requests
    await page.evaluate(() => {
      const videoElement = document.querySelector('video');
      if (videoElement) {
        videoElement.currentTime = 0;
        videoElement.play().catch(() => {});
      }
    });
    
    // Wait for potential requests
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Close page
    await page.close();
    
    return streamUrl;
  } catch (error) {
    logger.error(`Error getting stream URL with browser: ${error.message}`);
    return null;
  }
}

// Create a clip from a captured segment
async function createClip(clipId, startTime, duration) {
  logger.info(`Creating clip from segment ${clipId}, start=${startTime}s, duration=${duration}s`);
  
  try {
    // Get job info
    const job = activeJobs.get(clipId);
    if (!job) {
      throw new Error(`Clip job ${clipId} not found`);
    }
    
    // Check if segment is captured
    if (job.status !== 'captured') {
      throw new Error(`Segment for clip ${clipId} is not captured yet (status: ${job.status})`);
    }
    
    // Validate parameters
    if (startTime < 0) {
      throw new Error('Start time cannot be negative');
    }
    
    if (duration <= 0) {
      throw new Error('Duration must be positive');
    }
    
    if (startTime + duration > config.maxClipDuration) {
      throw new Error(`Clip exceeds maximum duration of ${config.maxClipDuration} seconds`);
    }
    
    // Update job status
    job.status = 'processing';
    job.progress = 0;
    activeJobs.set(clipId, job);
    
    // Define output file
    const outputFile = path.join(clipsDir, `${clipId}.mp4`);
    const thumbnailFile = path.join(thumbnailsDir, `${clipId}.jpg`);
    
    // Use FFmpeg to create clip
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'info',
        '-ss', startTime.toString(),
        '-i', job.outputFile,
        '-t', duration.toString(),
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y',
        outputFile
      ];
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      ffmpegProcess.stdout.on('data', (data) => {
        logger.debug(`FFmpeg stdout: ${data}`);
      });
      
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        logger.debug(`FFmpeg stderr: ${output}`);
        
        // Try to parse progress
        const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+.\d+)/);
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+.\d+)/);
        
        if (durationMatch && timeMatch) {
          const totalDurationHours = parseInt(durationMatch[1], 10);
          const totalDurationMinutes = parseInt(durationMatch[2], 10);
          const totalDurationSeconds = parseFloat(durationMatch[3]);
          
          const totalDuration = totalDurationHours * 3600 + totalDurationMinutes * 60 + totalDurationSeconds;
          
          const currentHours = parseInt(timeMatch[1], 10);
          const currentMinutes = parseInt(timeMatch[2], 10);
          const currentSeconds = parseFloat(timeMatch[3]);
          
          const currentTime = currentHours * 3600 + currentMinutes * 60 + currentSeconds;
          
          const progressPercent = Math.min(100, (currentTime / totalDuration) * 100);
          
          // Update job progress
          const job = activeJobs.get(clipId);
          if (job) {
            job.progress = progressPercent;
            activeJobs.set(clipId, job);
          }
        }
      });
      
      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          logger.info(`Successfully created clip ${clipId}`);
          
          // Create thumbnail
          createThumbnail(job.outputFile, thumbnailFile, startTime + (duration / 2))
            .then(() => {
              // Update job status
              job.status = 'completed';
              job.progress = 100;
              job.clipFile = outputFile;
              job.thumbnailFile = thumbnailFile;
              activeJobs.set(clipId, job);
              
              resolve({
                clipId,
                clipFile: outputFile,
                thumbnailFile,
                duration
              });
            })
            .catch(error => {
              logger.error(`Error creating thumbnail: ${error.message}`);
              
              // Still resolve with clip but no thumbnail
              job.status = 'completed';
              job.progress = 100;
              job.clipFile = outputFile;
              activeJobs.set(clipId, job);
              
              resolve({
                clipId,
                clipFile: outputFile,
                duration
              });
            });
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        reject(new Error(`FFmpeg error: ${error.message}`));
      });
    });
    
  } catch (error) {
    logger.error(`Error creating clip: ${error.message}`);
    
    // Update job status
    const job = activeJobs.get(clipId);
    if (job) {
      job.status = 'error';
      job.error = error.message;
      activeJobs.set(clipId, job);
    }
    
    throw error;
  }
}

// Create thumbnail from video
async function createThumbnail(videoFile, thumbnailFile, timePosition) {
  logger.info(`Creating thumbnail at position ${timePosition}s`);
  
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', timePosition.toString(),
      '-i', videoFile,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      thumbnailFile
    ];
    
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        logger.info(`Successfully created thumbnail at ${thumbnailFile}`);
        resolve(thumbnailFile);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpegProcess.on('error', (error) => {
      reject(new Error(`FFmpeg error: ${error.message}`));
    });
  });
}

// Generate preview frames for clip selection UI
async function generatePreviewFrames(clipId, numFrames = 10) {
  logger.info(`Generating ${numFrames} preview frames for ${clipId}`);
