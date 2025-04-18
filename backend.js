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
