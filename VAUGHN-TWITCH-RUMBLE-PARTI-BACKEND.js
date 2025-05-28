const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const winston = require('winston');
const ini = require('ini');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

const USER_IDS_TO_CHECK = [
    348242, 464860, 465731, 463000, 350101, 352176, 349100, 351548, 352357,
    352605, 352497, 353535, 351153, 351215, 350459, 352690, 352945, 567503
];
const VAUGHN_USERNAMES = ['ghost', 'onlyusemehouse', 'thefaroe'];
const TWITCH_USERNAMES = [
    'tnawrestling',
    'thechugs',
    'gcwrestling',
    'trumporbiden2028',
    'wrestlingleva',
    'jessickahavok',
    'coltcabana',
    'dramakingmatt',
    'liquidor',
    'ask_jesus',
    'dbr666',
    'nba',
    'wwe',
    'grimoire',
    'eviluno',
    'thenicolet',
    'whatever',
    'stinkycarnival',
    'dohertyjack',
    'greekgodx',
    'vpgloves',
    'kaceytron',
    'dankquan'
];

const BASE_LIVESTREAM_URL = 'https://api-backend.parti.com/parti_v2/profile/get_livestream_channel_info/';
const BASE_PROFILE_URL = 'https://api-backend.parti.com/parti_v2/profile/user_profile/';
const BASE_RECENT_URL = 'https://api-backend.parti.com/parti_v2/profile/user_profile_feed/';
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const VAUGHN_API_URL = 'https://api.vaughnsoft.net/v1/stream/vl/';

let TWITCH_CLIENT_ID;
let TWITCH_CLIENT_SECRET;
const CONFIG_FILE = path.join(__dirname, 'config.ini');

try {
    const config = ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    TWITCH_CLIENT_ID = config.twitch.client_id;
    TWITCH_CLIENT_SECRET = config.twitch.client_secret;
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        logger.error('Twitch API credentials (client_id or client_secret) are missing in config.ini');
        process.exit(1);
    }
} catch (err) {
    logger.error(`Failed to load config.ini: ${err.message}. Please ensure config.ini exists in the same directory as server.js.`);
    process.exit(1);
}

function getRelativeTime(timeInput) {
    let epochSeconds;
    if (typeof timeInput === 'string') {
        const date = new Date(timeInput);
        if (isNaN(date.getTime())) {
            logger.warn(`getRelativeTime: Invalid date string provided: ${timeInput}`);
            return 'Invalid date';
        }
        epochSeconds = Math.floor(date.getTime() / 1000);
    } else if (typeof timeInput === 'number') {
        epochSeconds = timeInput;
    } else {
        logger.warn(`getRelativeTime: Invalid timeInput type: ${typeof timeInput}`);
        return 'Unknown';
    }

    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = now - epochSeconds;

    if (diffSeconds < 0) {
      // If the time is in the future, likely due to clock differences or bad data.
      // Treat as "just now" or a very small difference to avoid "X time in future".
      return 'just now';
    }
    if (diffSeconds < 1) return 'just now';

    const units = [
        { name: 'year', seconds: 31536000 },
        { name: 'month', seconds: 2592000 },
        { name: 'day', seconds: 86400 },
        { name: 'hour', seconds: 3600 },
        { name: 'minute', seconds: 60 },
        { name: 'second', seconds: 1 }
    ];

    for (const unit of units) {
        const count = Math.floor(diffSeconds / unit.seconds);
        if (count >= 1) {
            return `${count} ${unit.name}${count !== 1 ? 's' : ''} ago`;
        }
    }
    return 'just now';
}

function formatNumberWithCommas(number) {
    if (typeof number !== 'number') {
        return String(number);
    }
    return number.toLocaleString('en-US');
}

async function getApiData(url, identifier, type) {
    try {
        const res = await axios.get(url, { headers: REQUEST_HEADERS, timeout: 10000 });
        return [res.data, null];
    } catch (err) {
        return [null, `${type} API Error for ${identifier}: ${err.message}`];
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
        getApiData(livestreamUrl, `Parti user ${userId}`, 'Livestream'),
        getApiData(profileUrl, `Parti user ${userId}`, 'Profile')
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
        const [recentData, recentError] = await getApiData(recentFeedUrl, `Parti user ${userId}`, 'Recent Feed');
        if (recentError) errorMessages.push(recentError);

        if (Array.isArray(recentData) && recentData.length > 0) {
            const createdAt = recentData[0].created_at;
            if (typeof createdAt === 'number') {
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

async function fetchVaughnStreamData(username) {
    try {
        const res = await axios.get(`${VAUGHN_API_URL}${username}`, { timeout: 10000 });
        const data = res.data;

        const baseOutput = {
            platform: 'vaughn',
            username: data.username || username,
            user_name: data.username || username, // Ensure user_name is populated
            profile_img: data.profile_img,
            online: data.live
        };

        if (data.live) {
            return {
                ...baseOutput,
                status_msg: Buffer.from(data.status_msg || '', 'base64').toString('utf-8'),
                viewers: String(data.viewers || 0)
            };
        } else {
            const lastEpoch = Number(data.lastlive) || 0;
            return {
                ...baseOutput,
                lastlive_epoch: lastEpoch,
            };
        }
    } catch (err) {
        logger.error(`Vaughn API error fetching data for ${username}: ${err.message}`);
        return {
            platform: 'vaughn',
            username: username,
            user_name: username, // Ensure user_name is populated for error cases
            online: false,
            error_details: `Vaughn API Error: ${err.message}`
        };
    }
}

async function safeQuery(page, selector) {
    try {
        // Wait for selector to be present in the DOM, then check visibility if needed, then get text
        await page.waitForSelector(selector, { timeout: 3000 }); // Reduced timeout for faster fails if element truly not there
        return await page.$eval(selector, el => el.textContent.trim());
    } catch (error) {
        // logger.warn(`safeQuery: Failed to find or get text from selector "${selector}": ${error.message}`);
        return null;
    }
}

async function safeAttr(page, selector, attr) {
    try {
        await page.waitForSelector(selector, { timeout: 3000 });
        return await page.$eval(selector, (el, attribute) => el.getAttribute(attribute), attr);
    } catch (error) {
        // logger.warn(`safeAttr: Failed to find or get attribute "${attr}" from selector "${selector}": ${error.message}`);
        return null;
    }
}

async function scrapeRumbleUser(browser, username, basePath) {
    let page;
    const listingUrl = `https://rumble.com/${basePath}/${username}/livestreams`;
    const data = {
        platform: 'rumble',
        username,
        basePath, // c or user
        user_name: username, // Default to username, will be overwritten by displayName
        url: listingUrl,
        lastChecked: new Date().toISOString(),
        status: 'offline', // Default status
        profilePhoto: null,
        displayName: null, // Will hold the scraped channel name
        title: null,
        viewers: 0,
        streamURL: null,
        _lastBroadcastTimestamp: null // Store raw timestamp string
    };

    try {
        page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType()) && !req.url().includes('rumbles.com')) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        logger.info(`RUMBLE: Navigating to channel listing page for ${username} (/${basePath}/): ${listingUrl}`);
        await page.goto(listingUrl, { waitUntil: 'load', timeout: 60000 });

        const pageTitle = await page.title();
        if (pageTitle.toLowerCase().includes('404 page not found') || page.url().includes('/404')) {
            data.status = 'not_found';
            logger.warn(`RUMBLE: Page not found for ${username} at ${listingUrl}`);
            if (page && !page.isClosed()) await page.close();
            return data;
        }
        
        // Check for the Rumble channel header area (contains display name, profile photo)
        const rumbleHeaderSelector = 'body > main > div[class*="channel-header"]'; // A more generic selector for the header parent
        const headerExists = await page.$(rumbleHeaderSelector);

        if (!headerExists) {
            // If the header isn't found, it might be a significant page structure issue or the user doesn't exist in a way we expect.
            data.status = 'not_found'; // Or a more specific 'structure_error' if not a 404
            logger.warn(`RUMBLE: Channel header area ('${rumbleHeaderSelector}') not found for ${username} at ${listingUrl}. Assuming not found or page structure changed.`);
            if (page && !page.isClosed()) await page.close();
            return data;
        }

        // Scrape profile photo (assuming it's within a general header structure)
        // This selector might need to be more robust or path-dependent if it fails.
        data.profilePhoto = await safeAttr(page, 'img.channel-header--img', 'src');

        // Scrape display name using the specific selectors provided by the user
        let displayNameSelector;
        if (basePath === 'c') {
            displayNameSelector = 'body > main > div > div.channel-header--content > div > div > div.channel-header--title > div > h1';
        } else if (basePath === 'user') {
            displayNameSelector = 'body > main > div > div.channel-header--content.channel-header--content-nobacksplash > div > div > div.channel-header--title > div > h1';
        } else {
            logger.error(`RUMBLE: Invalid basePath "${basePath}" provided for user ${username}. Cannot determine display name selector.`);
            displayNameSelector = null; 
        }

        if (displayNameSelector) {
            data.displayName = await safeQuery(page, displayNameSelector);
            if (data.displayName) {
                data.user_name = data.displayName; // Update user_name with the scraped display name
            } else {
                 logger.warn(`RUMBLE: Could not scrape display name for ${username} using selector: ${displayNameSelector}`);
                 // data.user_name will remain the initial 'username' if scraping fails
            }
        }

        // Now, check for the video list section, as per the new last broadcast time selector
        const videoListContainerSelector = 'body > main > section > ol'; 
        const videoListExists = await page.$(videoListContainerSelector);

        if (videoListExists) {
            const videoListItemBasePath = 'body > main > section > ol > div:nth-child(1)'; // Base for the first video item in the list

            // Check for live status badge within the video list item
            const liveBadgeSelector = `${videoListItemBasePath} > div.thumbnail__thumb.thumbnail__thumb--live > div > div.videostream__badge.videostream__status.videostream__status--live`;
            const isLiveElement = await page.$(liveBadgeSelector);

            if (isLiveElement) {
                logger.info(`RUMBLE: ${username} is LIVE (detected on listing page).`);
                data.status = 'live';
                data.title = await safeQuery(page, `${videoListItemBasePath} h3.thumbnail__title`);

                const liveStreamLinkSelector = `${videoListItemBasePath} > div.thumbnail__thumb.thumbnail__thumb--live > a`;
                data.streamURL = await safeAttr(page, liveStreamLinkSelector, 'href');
                if (data.streamURL && !data.streamURL.startsWith('http')) {
                    data.streamURL = `https://rumble.com${data.streamURL}`;
                }
                
                const viewerCountSelector = `${videoListItemBasePath} > div.thumbnail__thumb.thumbnail__thumb--live > div > div.videostream__badge.videostream__views-ppv > span`;
                const viewersText = await safeQuery(page, viewerCountSelector);
                if (viewersText) {
                    const parsedViewers = parseInt(viewersText.replace(/[^\d]/g, '')) || 0;
                    data.viewers = parsedViewers;
                    logger.info(`RUMBLE: Retrieved viewer count for ${username}: ${data.viewers}`);
                } else {
                    logger.warn(`RUMBLE: Viewer count element not found or text was empty for live user ${username}. Defaulting to 0.`);
                    data.viewers = 0;
                }
            } else {
                logger.info(`RUMBLE: ${username} is OFFLINE.`);
                data.status = 'offline';
                
                // Use the new specific selector for last broadcast time, as provided by the user
                const lastBroadcastTimeSelector = 'body > main > section > ol > div:nth-child(1) > div.videostream__footer > address > div.videostream__data > span.videostream__data--item.videostream__date > time';
                const lastDateRaw = await safeAttr(page, lastBroadcastTimeSelector, 'datetime');

                if (lastDateRaw) {
                    data._lastBroadcastTimestamp = lastDateRaw; 
                    logger.info(`RUMBLE: Last broadcast for ${username}: ${lastDateRaw}`);
                    
                    // Get title and link of the last video (first item in the list)
                    data.title = await safeQuery(page, `${videoListItemBasePath} h3.thumbnail__title`);
                    const lastVideoLink = await safeAttr(page, `${videoListItemBasePath} a.thumbnail__link`, 'href'); // General link for the first item
                    if (lastVideoLink) {
                        data.streamURL = lastVideoLink.startsWith('http') ? lastVideoLink : `https://rumble.com${lastVideoLink}`;
                    }
                } else {
                    logger.warn(`RUMBLE: Could not find last broadcast time for offline user ${username} using selector: ${lastBroadcastTimeSelector}. No recent videos or structure changed.`);
                }
            }
        } else {
            logger.warn(`RUMBLE: Video list container ('${videoListContainerSelector}') not found for ${username}. Channel might have no videos listed.`);
            // data.status remains 'offline' (default), and _lastBroadcastTimestamp remains null.
        }

    } catch (e) {
        logger.error(`RUMBLE: General error scraping user ${username} (${basePath}): ${e.message}`, e.stack);
        data.status = 'error';
        data.error_details = e.message;
    } finally {
        if (page && !page.isClosed()) {
            try {
                await page.close();
            } catch (closeError) {
                logger.error(`RUMBLE: Error closing page for ${username}: ${closeError.message}`);
            }
        }
    }
    return data;
}


async function scrapeAllRumbleUsers() {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true, 
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', 
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu' 
            ]
        });

        const RUMBLE_USERS_CPATH = ["Loulz", "AlabamaJohn", "c-6629097", "RIOTCOKE", "wappyflanker", "OGGeezer", "JohnnySomali", "AttilaBakk", "WORLDOFTSHIRTSATLSTV"];
        const RUMBLE_USERS_USERPATH = ["OUMB2", "wcracksparrow", "RealAldy1k", "YoungCheeto", "MrBumTickler", "ChrisKbuster", "Bjorntv4", "lildealy", "BlackoutAndy", "SatouTatsuhirosNHKSurvivalVlog", "Buzzbong"];

        const allUsernames = [
            ...RUMBLE_USERS_CPATH.map(u => ({ username: u, basePath: 'c' })),
            ...RUMBLE_USERS_USERPATH.map(u => ({ username: u, basePath: 'user' }))
        ];

        let results = [];
        for (const { username, basePath } of allUsernames) {
            logger.info(`RUMBLE: Starting scrape for ${username} (/${basePath}/)`);
            const userData = await scrapeRumbleUser(browser, username, basePath);
            results.push(userData);
        }
        return results;
    } catch (launchError) {
        logger.error(`RUMBLE: Failed to launch browser or critical error in scrapeAllRumbleUsers: ${launchError.message}`, launchError.stack);
        return []; 
    } finally {
        if (browser) {
            await browser.close();
            logger.info("RUMBLE: Browser closed.");
        }
    }
}

async function getTwitchAccessToken() {
    try {
        const response = await axios.post(`https://id.twitch.tv/oauth2/token`, null, {
            params: {
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                grant_type: 'client_credentials',
            },
        });
        return response.data.access_token;
    } catch (error) {
        logger.error(`Twitch: Error getting access token: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        return null;
    }
}

async function getTwitchUsers(headers) {
    try {
        const chunkSize = 100;
        let allUsers = [];
        for (let i = 0; i < TWITCH_USERNAMES.length; i += chunkSize) {
            const chunk = TWITCH_USERNAMES.slice(i, i + chunkSize);
            const response = await axios.get(`https://api.twitch.tv/helix/users`, {
                headers,
                params: { login: chunk }, 
            });
            allUsers = allUsers.concat(response.data.data);
        }
        return allUsers;
    } catch (error) {
        logger.error(`Twitch: Error getting users: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        return [];
    }
}

async function getTwitchStreams(headers, userIds) {
    try {
        const chunkSize = 100;
        let allStreams = [];
        for (let i = 0; i < userIds.length; i += chunkSize) {
            const chunk = userIds.slice(i, i + chunkSize);
            const response = await axios.get(`https://api.twitch.tv/helix/streams`, {
                headers,
                params: { user_id: chunk },
            });
            allStreams = allStreams.concat(response.data.data);
        }
        return allStreams;
    } catch (error) {
        logger.error(`Twitch: Error getting streams: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        return [];
    }
}

async function getTwitchLatestVideos(headers, userIds) {
    const videos = [];
    for (const userId of userIds) {
        try {
            const response = await axios.get(`https://api.twitch.tv/helix/videos`, {
                headers,
                params: { user_id: userId, first: 1, type: 'archive', sort: 'time' }, 
            });
            if (response.data.data.length > 0) {
                videos.push(response.data.data[0]);
            }
        } catch (error) {
            logger.error(`Twitch: Error getting latest video for user ${userId}: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        }
    }
    return videos;
}


async function fetchTwitchData() {
    logger.info('TWITCH: Starting to fetch Twitch data...');
    try {
        const accessToken = await getTwitchAccessToken();
        if (!accessToken) {
            logger.error('TWITCH: Failed to get Twitch access token. Skipping Twitch data fetch.');
            return [];
        }

        const headers = {
            'Client-ID': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${accessToken}`,
        };

        const users = await getTwitchUsers(headers); 
        if (!users || users.length === 0) {
            logger.warn('TWITCH: No user data returned from Twitch API.');
            return [];
        }
        
        const userMap = Object.fromEntries(users.map(u => [u.id, u]));
        const userIds = users.map(u => u.id);

        const streams = await getTwitchStreams(headers, userIds); 
        const onlineUserIds = new Set(streams.map(s => s.user_id));

        const onlineTwitch = streams.map(s => ({
            platform: 'twitch',
            username: s.user_login, 
            user_name: s.user_name, 
            profile_image_url: userMap[s.user_id]?.profile_image_url,
            title: s.title,
            viewer_count: s.viewer_count,
            _isOnline: true,
            _lastBroadcastEpoch: Math.floor(new Date(s.started_at).getTime() / 1000) 
        }));

        const offlineUserIds = userIds.filter(id => !onlineUserIds.has(id));
        let offlineTwitch = [];
        if (offlineUserIds.length > 0) {
            const videos = await getTwitchLatestVideos(headers, offlineUserIds);
            offlineTwitch = videos.map(v => ({
                platform: 'twitch',
                username: v.user_login, 
                user_name: v.user_name, 
                profile_image_url: userMap[v.user_id]?.profile_image_url,
                last_broadcast_date: v.created_at, 
                _isOnline: false,
                _lastBroadcastEpoch: v.created_at ? Math.floor(new Date(v.created_at).getTime() / 1000) : 0
            }));
        }
        
        logger.info(`TWITCH: Fetched ${onlineTwitch.length} online and ${offlineTwitch.length} offline Twitch users.`);
        return [...onlineTwitch, ...offlineTwitch];

    } catch (error) {
        logger.error(`TWITCH: General error fetching Twitch data: ${error.message}`);
        return [];
    }
}


async function fetchAllStreamData() {
    logger.info('FETCH_ALL: Starting to fetch data from all platforms...');
    const partiPromise = Promise.all(USER_IDS_TO_CHECK.map(fetchPartiUserData))
        .catch(err => { logger.error("FETCH_ALL: Error fetching Parti data array:", err); return []; });
    const vaughnPromise = Promise.all(VAUGHN_USERNAMES.map(fetchVaughnStreamData))
        .catch(err => { logger.error("FETCH_ALL: Error fetching Vaughn data array:", err); return []; });
    const rumblePromise = scrapeAllRumbleUsers() 
        .catch(err => { logger.error("FETCH_ALL: Error fetching Rumble data array:", err); return []; });
    const twitchPromise = fetchTwitchData() 
        .catch(err => { logger.error("FETCH_ALL: Error fetching Twitch data array:", err); return []; });

    const results = await Promise.allSettled([
        partiPromise,
        vaughnPromise,
        rumblePromise,
        twitchPromise
    ]);

    const partiData = results[0].status === 'fulfilled' ? results[0].value : [];
    const vaughnData = results[1].status === 'fulfilled' ? results[1].value : [];
    const rumbleData = results[2].status === 'fulfilled' ? results[2].value : [];
    const twitchData = results[3].status === 'fulfilled' ? results[3].value : [];
    
    logger.info(`FETCH_ALL: Fetched ${partiData.length} Parti, ${vaughnData.length} Vaughn, ${rumbleData.length} Rumble, ${twitchData.length} Twitch users.`);

    const allData = [...partiData, ...vaughnData, ...rumbleData, ...twitchData].filter(Boolean); 

    const processedData = allData.map(user => {
        const isOnline = user.is_live || user.online || user.status === 'live' || user._isOnline === true;
        
        let viewers = 0;
        if (isOnline) {
            viewers = parseInt(user.viewer_count || user.viewers || 0) || 0;
        }

        let lastBroadcastEpoch = 0;
        if (!isOnline) {
            if (user.platform === 'parti' && user._last_broadcast_ts) {
                lastBroadcastEpoch = user._last_broadcast_ts;
            } else if (user.platform === 'vaughn' && user.lastlive_epoch) {
                lastBroadcastEpoch = user.lastlive_epoch;
            } else if (user.platform === 'rumble' && user._lastBroadcastTimestamp) { 
                const date = new Date(user._lastBroadcastTimestamp);
                if (!isNaN(date.getTime())) {
                    lastBroadcastEpoch = Math.floor(date.getTime() / 1000);
                }
            } else if (user.platform === 'twitch' && user._lastBroadcastEpoch) { 
                 lastBroadcastEpoch = user._lastBroadcastEpoch;
            }
        } else { 
            lastBroadcastEpoch = Math.floor(Date.now() / 1000);
        }
        
        let finalUserName = user.user_name || user.username || user.displayName || 'N/A';
        if (user.platform === 'rumble' && user.displayName) { 
            finalUserName = user.displayName;
        }


        return {
            ...user, 
            user_name: finalUserName,
            _isOnline: isOnline,
            _viewers: viewers, 
            _lastBroadcastEpoch: lastBroadcastEpoch, 
            platform: user.platform || 'unknown'
        };
    });

    processedData.sort((a, b) => {
        if (a._isOnline && !b._isOnline) return -1; 
        if (!a._isOnline && b._isOnline) return 1;  

        if (a._isOnline && b._isOnline) { 
            return b._viewers - a._viewers; 
        }

        if (!a._isOnline && !b._isOnline) { 
            return b._lastBroadcastEpoch - a._lastBroadcastEpoch; 
        }
        return 0; 
    });
    
    const finalOutputData = processedData.map(user => {
        const finalUser = {
            platform: user.platform,
            user_name: user.user_name, 
            lastChecked: user.lastChecked || new Date().toISOString(), 
        };

        if (user.platform === 'parti') {
            Object.assign(finalUser, {
                user_id: user.user_id,
                avatar_link: user.avatar_link,
                social_media: user.social_media,
                social_username: user.social_username,
                creator_url: user.creator_url,
                is_live: user._isOnline 
            });
            if (user._isOnline) {
                finalUser.viewer_count = formatNumberWithCommas(user._viewers);
                finalUser.event_name = user.event_name;
            } else {
                finalUser.last_broadcast = user._lastBroadcastEpoch ? getRelativeTime(user._lastBroadcastEpoch) : 'Unknown';
            }
        } else if (user.platform === 'vaughn') {
            Object.assign(finalUser, {
                username: user.username, 
                profile_img: user.profile_img,
                online: user._isOnline 
            });
            if (user._isOnline) {
                finalUser.status_msg = user.status_msg;
                finalUser.viewers = formatNumberWithCommas(user._viewers);
            } else {
                finalUser.last_live_relative = user._lastBroadcastEpoch ? getRelativeTime(user._lastBroadcastEpoch) : 'Unknown';
            }
        } else if (user.platform === 'rumble') {
            Object.assign(finalUser, {
                username: user.username, 
                basePath: user.basePath,
                profilePhoto: user.profilePhoto,
                status: user.status, 
                url: user.url, 
                streamURL: user.streamURL 
            });
            if (user.status === 'live') { 
                finalUser.title = user.title;
                finalUser.viewers = formatNumberWithCommas(user._viewers);
            } else if (user.status === 'offline') {
                finalUser.title = user.title; 
                finalUser.lastBroadcastDate = user._lastBroadcastEpoch ? getRelativeTime(user._lastBroadcastEpoch) : 'Unknown';
            } else if (user.status === 'not_found') {
                finalUser.title = "User not found";
            }
        } else if (user.platform === 'twitch') {
            Object.assign(finalUser, {
                username: user.username, 
                profile_image_url: user.profile_image_url,
                is_live: user._isOnline 
            });
            if (user._isOnline) {
                finalUser.title = user.title;
                finalUser.viewer_count = formatNumberWithCommas(user._viewers); 
            } else {
                finalUser.last_broadcast = user._lastBroadcastEpoch ? getRelativeTime(user._lastBroadcastEpoch) : 'Unknown';
            }
        }
        
        if (user.error_details) { 
            finalUser.error_details = user.error_details;
        }

        return finalUser;
    });

    return finalOutputData;
}


const OUTPUT_FILE = path.join(__dirname, 'data.json');

cron.schedule('*/1 * * * *', () => {
    logger.info('CRON: Triggering scheduled data update...');
    updateDataFile();
});

async function updateDataFile() {
    logger.info('CRON: Starting data update cycle...');
    try {
        const streamData = await fetchAllStreamData(); 
        
        const finalProcessedDataWithTBA = streamData.map(user => {
            const finalUser = { ...user }; 

            if (finalUser.platform === 'parti' && !finalUser.is_live && finalUser.last_broadcast && (finalUser.last_broadcast === 'Unknown' || finalUser.last_broadcast === 'Invalid date')) {
                finalUser.last_broadcast = 'TBA';
            } 
            else if (finalUser.platform === 'vaughn' && !finalUser.online && finalUser.last_live_relative && (finalUser.last_live_relative === 'Unknown' || finalUser.last_live_relative === 'Invalid date')) {
                finalUser.last_live_relative = 'TBA';
            } 
            else if (finalUser.platform === 'rumble' && finalUser.status === 'offline' && finalUser.lastBroadcastDate && (finalUser.lastBroadcastDate === 'Unknown' || finalUser.lastBroadcastDate === 'Invalid date')) {
                finalUser.lastBroadcastDate = 'TBA';
            } 
            else if (finalUser.platform === 'twitch' && !finalUser.is_live && finalUser.last_broadcast && (finalUser.last_broadcast === 'Unknown' || finalUser.last_broadcast === 'Invalid date')) {
                finalUser.last_broadcast = 'TBA';
            }
            return finalUser;
        });

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalProcessedDataWithTBA, null, 2));
        logger.info(`CRON: data.json updated successfully with ${finalProcessedDataWithTBA.length} entries.`);
    } catch (err) {
        logger.error(`CRON: Failed to update data.json: ${err.message}`, err.stack);
    }
}


(async () => {
    logger.info('STARTUP: Performing initial data fetch and write...');
    await updateDataFile();
})();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
    const filePath = path.join(__dirname, 'data.json');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath, (err) => {
            if (err) {
                logger.error(`API: Error sending data.json file: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to send data file.' });
                }
            } else {
                logger.info('API: data.json successfully served.');
            }
        });
    } else {
        logger.error('API: data.json not found for /api/data request. It might be updating or failed to generate.');
        if (!res.headersSent) {
            res.status(404).json({ error: 'Data file not found. It might be updating. Please try again shortly.' });
        }
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    logger.info(`SERVER: Express server is running and listening on http://localhost:${PORT}`);
    logger.info(`SERVER: API endpoint available at http://localhost:${PORT}/api/data`);
    logger.info(`SERVER: Frontend served from 'public' directory (e.g., http://localhost:${PORT}/index.html)`);
});
