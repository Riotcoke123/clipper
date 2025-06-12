const express = require("express"),
  fs = require("fs"),
  path = require("path"),
  axios = require("axios"),
  cron = require("node-cron"),
  puppeteer = require("puppeteer-extra"), // Use puppeteer-extra
  StealthPlugin = require("puppeteer-extra-plugin-stealth"), // Import StealthPlugin
  winston = require("winston"),
  ini = require("ini"),
  dayjs = require("dayjs"),
  relativeTime = require("dayjs/plugin/relativeTime");

// Extend dayjs with relativeTime plugin
dayjs.extend(relativeTime);

// Use stealth plugin with puppeteer-extra
puppeteer.use(StealthPlugin());

// --- Logger Setup ---
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({
      timestamp: e,
      level: t,
      message: a
    }) => `${e} [${t.toUpperCase()}]: ${a}`)
  ),
  transports: [new winston.transports.Console()],
});

// --- User Lists for Various Platforms ---
const USER_IDS_TO_CHECK = [348242, 464860, 465731, 463e3, 350101, 352176, 349100, 351548, 352357, 352605, 352497, 353535, 351153, 351215, 350459, 352690, 352945, 567503];
const VAUGHN_USERNAMES = ["ghost", "onlyusemehouse", "thefaroe"];
const TWITCH_USERNAMES = ["tnawrestling", "thechugs", "gcwrestling", "trumporbiden2028", "wrestlingleva", "jessickahavok", "coltcabana", "dramakingmatt", "liquidor", "ask_jesus", "dbr666", "nba", "wwe", "grimoire", "eviluno", "thenicolet", "whatever", "stinkycarnival", "dohertyjack", "greekgodx", "vpgloves", "kaceytron", "dankquan"];
const RUMBLE_USERS_CPATH = ["Loulz", "AlabamaJohn", "c-6629097", "RIOTCOKE", "wappyflanker", "OGGeezer", "JohnnySomali", "AttilaBakk", "WORLDOFTSHIRTSATLSTV"];
const RUMBLE_USERS_USERPATH = ["OUMB2", "wcracksparrow", "RealAldy1k", "YoungCheeto", "MrBumTickler", "ChrisKbuster", "Bjorntv4", "lildealy", "BlackoutAndy", "SatouTatsuhirosNHKSurvivalVlog", "Buzzbong"];
const TROVO_USERNAMES = ["SenserTV", "iNation", "givethemone"];
const YOUTUBE_USERNAMES = ['SmokeNScan', 'BillyJohnOh', 'OfficialDangerRanger', 'OGGEEZERLIVE', 'PortlandAndy', 'Scribblesirl', 'ETCZEBBS', 'SHABISKY', 'CCUnit']; // Added YouTube usernames

// --- API Endpoints & Configuration ---
const BASE_LIVESTREAM_URL = "https://api-backend.parti.com/parti_v2/profile/get_livestream_channel_info/";
const BASE_PROFILE_URL = "https://api-backend.parti.com/parti_v2/profile/user_profile/";
const BASE_RECENT_URL = "https://api-backend.parti.com/parti_v2/profile/user_profile_feed/";
const VAUGHN_API_URL = "https://api.vaughnsoft.net/v1/stream/vl/";
const TROVO_API_URL = "https://open-api.trovo.live/openplatform";
const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
};
const CONFIG_FILE = path.join(__dirname, "config.ini");

let TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TROVO_CLIENT_ID;

// --- Load API Credentials from config.ini ---
try {
  const e = ini.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  TWITCH_CLIENT_ID = e.twitch.client_id;
  TWITCH_CLIENT_SECRET = e.twitch.client_secret;
  TROVO_CLIENT_ID = e.trovo.client_id;

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    logger.error("Twitch API credentials (client_id or client_secret) are missing in config.ini");
    process.exit(1);
  }
  if (!TROVO_CLIENT_ID) {
    logger.error("Trovo API client_id is missing in config.ini");
    process.exit(1);
  }
} catch (e) {
  logger.error(`Failed to load config.ini: ${e.message}. Please ensure config.ini exists in the same directory as server.js.`);
  process.exit(1);
}

// --- Utility Functions ---

/**
 * Calculates the relative time from a given timestamp.
 * @param {number|string} timeInput - The timestamp (epoch seconds) or date string.
 * @returns {string} The relative time (e.g., "5 minutes ago", "just now").
 */
function getRelativeTime(timeInput) {
  let timestampInSeconds;
  if (typeof timeInput === "string") {
    const date = new Date(timeInput);
    if (isNaN(date.getTime())) {
      logger.warn(`getRelativeTime: Invalid date string provided: ${timeInput}`);
      return "Invalid date";
    }
    timestampInSeconds = Math.floor(date.getTime() / 1e3);
  } else if (typeof timeInput === "number") {
    timestampInSeconds = timeInput;
  } else {
    logger.warn("getRelativeTime: Invalid timeInput type: " + typeof timeInput);
    return "Unknown";
  }

  const secondsElapsed = Math.floor(Date.now() / 1e3) - timestampInSeconds;

  if (secondsElapsed < 0) return "just now"; // Future date
  if (secondsElapsed < 1) return "just now";

  const intervals = [{
    name: "year",
    seconds: 31536e3
  }, {
    name: "month",
    seconds: 2592e3
  }, {
    name: "day",
    seconds: 86400
  }, {
    name: "hour",
    seconds: 3600
  }, {
    name: "minute",
    seconds: 60
  }, {
    name: "second",
    seconds: 1}, ];

  for (const interval of intervals) {
    const count = Math.floor(secondsElapsed / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.name}${1 !== count ? "s" : ""} ago`;
    }
  }
  return "just now";
}

/**
 * Formats a number with commas for readability.
 * @param {number} num - The number to format.
 * @returns {string} The formatted number string.
 */
function formatNumberWithCommas(num) {
  return typeof num !== "number" ? String(num) : num.toLocaleString("en-US");
}

/**
 * Fetches data from a given API endpoint.
 * @param {string} url - The API endpoint URL.
 * @param {string} userIdentifier - Identifier for logging purposes.
 * @param {string} apiName - Name of the API for error logging.
 * @param {object} [options={}] - Additional Axios request options.
 * @returns {Promise<[object|null, string|null]>} A tuple of [data, error].
 */
async function getApiData(url, userIdentifier, apiName, options = {}) {
  try {
    const response = await axios.get(url, {
      headers: REQUEST_HEADERS,
      timeout: 1e4, // 10 seconds timeout
      ...options
    });
    return [response.data, null];
  } catch (e) {
    return [null, `${apiName} API Error for ${userIdentifier}: ${e.message}`];
  }
}

// --- Platform-Specific Data Fetchers ---

/**
 * Fetches user data from Parti.
 * @param {number} userId - The Parti user ID.
 * @returns {Promise<object>} Processed Parti user data.
 */
async function fetchPartiUserData(userId) {
  const livestreamUrl = `${BASE_LIVESTREAM_URL}${userId}`;
  const profileUrl = `${BASE_PROFILE_URL}${userId}`;
  const recentUrl = `${BASE_RECENT_URL}${userId}?&limit=5`;

  const [[livestreamData, livestreamError], [profileData, profileError]] = await Promise.all([
    getApiData(livestreamUrl, `Parti user ${userId}`, "Livestream"),
    getApiData(profileUrl, `Parti user ${userId}`, "Profile"),
  ]);

  let userName = "N/A";
  let avatarLink = null;
  let socialMedia = null;
  let socialUsername = null;
  let creatorUrl = null;
  const errorDetails = [];

  if (livestreamError) errorDetails.push(livestreamError);
  if (profileError) errorDetails.push(profileError);

  if (profileData) {
    userName = profileData.user_name || "N/A";
    avatarLink = profileData.avatar_link || null;
    socialMedia = profileData.social_media || null;
    socialUsername = profileData.social_username || null;
    if (socialMedia && socialUsername) {
      creatorUrl = `https://parti.com/creator/${socialMedia}/${socialUsername}`;
    }
  } else {
    logger.warn(`Could not fetch profile for Parti user ${userId}. Some info will be missing.`);
  }

  const data = {
    platform: "parti",
    user_id: userId,
    user_name: userName,
    avatar_link: avatarLink,
    social_media: socialMedia,
    social_username: socialUsername,
    creator_url: creatorUrl,
    is_live: false, // Default to false
  };

  if (livestreamData?.is_streaming_live_now) {
    const channelInfo = livestreamData.channel_info || {};
    const viewerCount = (channelInfo.stream || {}).viewer_count;
    const eventName = (channelInfo.livestream_event_info || {}).event_name;
    Object.assign(data, {
      is_live: true,
      viewer_count: viewerCount,
      event_name: eventName,
      _isOnline: true, // Internal flag for consistent sorting
      _viewers: parseInt(viewerCount) || 0, // Ensure numeric for sorting
      _lastBroadcastEpoch: Math.floor(Date.now() / 1000), // Current time if live
    });
  } else {
    data.is_live = false;
    const [recentFeedData, recentFeedError] = await getApiData(recentUrl, `Parti user ${userId}`, "Recent Feed");
    if (recentFeedError) errorDetails.push(recentFeedError);

    if (Array.isArray(recentFeedData) && recentFeedData.length > 0) {
      const createdAt = recentFeedData[0].created_at;
      if (typeof createdAt === "number") {
        data._last_broadcast_ts = createdAt;
        data._lastBroadcastEpoch = createdAt; // Internal flag for consistent sorting
      } else {
        logger.warn(`Invalid or missing 'created_at' in recent feed for Parti user ${userId}`);
        data._lastBroadcastEpoch = 0; // Default if no valid timestamp
      }
    } else {
      logger.info(`No recent feed data found to determine last broadcast for offline Parti user ${userId}`);
      data._lastBroadcastEpoch = 0; // Default if no recent feed
    }
    data._isOnline = false;
    data._viewers = 0;
  }

  if (errorDetails.length > 0) {
    data.error_details = errorDetails.join("; ");
  }
  return data;
}

/**
 * Fetches stream data from Vaughn.
 * @param {string} username - The Vaughn username.
 * @returns {Promise<object>} Processed Vaughn stream data.
 */
async function fetchVaughnStreamData(username) {
  try {
    const response = await axios.get(`${VAUGHN_API_URL}${username}`, {
      timeout: 1e4
    });
    const data = response.data;
    const common = {
      platform: "vaughn",
      username: data.username || username,
      user_name: data.username || username,
      profile_img: data.profile_img,
      online: data.live,
    };

    if (data.live) {
      return {
        ...common,
        status_msg: Buffer.from(data.status_msg || "", "base64").toString("utf-8"),
        viewers: String(data.viewers || 0),
        _isOnline: true,
        _viewers: parseInt(data.viewers) || 0,
        _lastBroadcastEpoch: Math.floor(Date.now() / 1000), // Current time if live
      };
    } else {
      const lastLiveEpoch = Number(data.lastlive) || 0;
      return {
        ...common,
        lastlive_epoch: lastLiveEpoch,
        _isOnline: false,
        _viewers: 0,
        _lastBroadcastEpoch: lastLiveEpoch,
      };
    }
  } catch (e) {
    logger.error(`Vaughn API error fetching data for ${username}: ${e.message}`);
    return {
      platform: "vaughn",
      username: username,
      user_name: username,
      online: false,
      _isOnline: false,
      _viewers: 0,
      _lastBroadcastEpoch: 0, // Default to 0 on error
      error_details: `Vaughn API Error: ${e.message}`
    };
  }
}

/**
 * Safely queries text content from a selector.
 * @param {object} page - Puppeteer page object.
 * @param {string} selector - CSS selector.
 * @returns {Promise<string|null>} Text content or null if not found/error.
 */
async function safeQuery(page, selector) {
  try {
    await page.waitForSelector(selector, {
      timeout: 3e3
    }); // 3 seconds timeout
    return await page.$eval(selector, (el) => el.textContent.trim());
  } catch (e) {
    return null;
  }
}

/**
 * Safely queries an attribute value from a selector.
 * @param {object} page - Puppeteer page object.
 * @param {string} selector - CSS selector.
 * @param {string} attribute - Attribute name.
 * @returns {Promise<string|null>} Attribute value or null if not found/error.
 */
async function safeAttr(page, selector, attribute) {
  try {
    await page.waitForSelector(selector, {
      timeout: 3e3
    }); // 3 seconds timeout
    return await page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);
  } catch (e) {
    return null;
  }
}

/**
 * Scrapes a single Rumble user's stream information.
 * @param {object} browser - Puppeteer browser instance.
 * @param {string} username - The Rumble username.
 * @param {"c"|"user"} basePath - The base path for the Rumble channel (e.g., "c" for channel, "user" for user).
 * @returns {Promise<object>} Processed Rumble user data.
 */
async function scrapeRumbleUser(browser, username, basePath) {
  let page;
  const url = `https://rumble.com/${basePath}/${username}/livestreams`;
  const result = {
    platform: "rumble",
    username: username,
    basePath: basePath,
    user_name: username,
    url: url,
    lastChecked: (new Date()).toISOString(),
    status: "offline", // Default status
    profilePhoto: null,
    displayName: null,
    title: null,
    viewers: 0,
    streamURL: null,
    _lastBroadcastTimestamp: null, // Raw timestamp for sorting
    _isOnline: false, // Internal flag
    _viewers: 0, // Internal flag
    _lastBroadcastEpoch: 0, // Internal flag
  };

  try {
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      // Abort requests for images, stylesheets, fonts, media not from rumbles.com
      if (
        ["image", "stylesheet", "font", "media"].includes(req.resourceType()) &&
        !req.url().includes("rumbles.com")
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    logger.info(`RUMBLE: Navigating to channel listing page for ${username} (/${basePath}/): ${url}`);
    await page.goto(url, {
      waitUntil: "load",
      timeout: 60000
    }); // 60 seconds timeout

    // Check for 404 page
    if ((await page.title()).toLowerCase().includes("404 page not found") || page.url().includes("/404")) {
      result.status = "not_found";
      result.error_details = "Rumble channel page not found.";
      logger.warn(`RUMBLE: Page not found for ${username} at ${url}`);
      return result;
    }

    // Check for channel header (indicates valid channel page)
    const channelHeaderSelector = 'body > main > div[class*="channel-header"]';
    if (!await page.$(channelHeaderSelector)) {
      result.status = "not_found";
      result.error_details = "Rumble channel header not found, page structure might have changed.";
      logger.warn(`RUMBLE: Channel header area ('${channelHeaderSelector}') not found for ${username} at ${url}. Assuming not found or page structure changed.`);
      return result;
    }

    // Scrape profile photo
    result.profilePhoto = await safeAttr(page, "img.channel-header--img", "src");

    // Determine display name selector based on basePath
    let displayNameSelector;
    if (basePath === "c") {
      displayNameSelector = "body > main > div > div.channel-header--content > div > div > div.channel-header--title > div > h1";
    } else if (basePath === "user") {
      displayNameSelector = "body > main > div > div.channel-header--content.channel-header--content-nobacksplash > div > div > div.channel-header--title > div > h1";
    } else {
      logger.error(`RUMBLE: Invalid basePath "${basePath}" provided for user ${username}. Cannot determine display name selector.`);
      displayNameSelector = null;
    }

    if (displayNameSelector) {
      result.displayName = await safeQuery(page, displayNameSelector);
      if (result.displayName) {
        result.user_name = result.displayName; // Use display name as user_name
      } else {
        logger.warn(`RUMBLE: Could not scrape display name for ${username} using selector: ${displayNameSelector}`);
      }
    }

    // Check for live stream or last broadcast
    const videoListContainer = "body > main > section > ol";
    if (await page.$(videoListContainer)) {
      const firstVideoElement = "body > main > section > ol > div:nth-child(1)";
      const liveBadgeSelector = `${firstVideoElement} > div.thumbnail__thumb.thumbnail__thumb--live > div > div.videostream__badge.videostream__status.videostream__status--live`;

      if (await page.$(liveBadgeSelector)) {
        // User is LIVE
        logger.info(`RUMBLE: ${username} is LIVE (detected on listing page).`);
        result.status = "live";
        result._isOnline = true;

        result.title = await safeQuery(page, `${firstVideoElement} h3.thumbnail__title`);

        const streamLinkElement = `${firstVideoElement} > div.thumbnail__thumb.thumbnail__thumb--live > a`;
        result.streamURL = await safeAttr(page, streamLinkElement, "href");
        if (result.streamURL && !result.streamURL.startsWith("http")) {
          result.streamURL = `https://rumble.com${result.streamURL}`;
        }

        const viewerCountSelector = `${firstVideoElement} > div.thumbnail__thumb.thumbnail__thumb--live > div > div.videostream__badge.videostream__views-ppv > span`;
        const viewerCountText = await safeQuery(page, viewerCountSelector);
        if (viewerCountText) {
          const viewers = parseInt(viewerCountText.replace(/[^\d]/g, "")) || 0;
          result.viewers = viewers;
          result._viewers = viewers; // Internal flag
          logger.info(`RUMBLE: Retrieved viewer count for ${username}: ${result.viewers}`);
        } else {
          logger.warn(`RUMBLE: Viewer count element not found or text was empty for live user ${username}. Defaulting to 0.`);
          result.viewers = 0;
          result._viewers = 0; // Internal flag
        }
        result._lastBroadcastEpoch = Math.floor(Date.now() / 1000); // Current time if live

      } else {
        // User is OFFLINE
        logger.info(`RUMBLE: ${username} is OFFLINE.`);
        result.status = "offline";
        result._isOnline = false;

        const lastBroadcastTimeSelector = "body > main > section > ol > div:nth-child(1) > div.videostream__footer > address > div.videostream__data > span.videostream__data--item.videostream__date > time";
        const lastBroadcastDatetime = await safeAttr(page, lastBroadcastTimeSelector, "datetime");
        if (lastBroadcastDatetime) {
          result._lastBroadcastTimestamp = lastBroadcastDatetime;
          result._lastBroadcastEpoch = dayjs(lastBroadcastDatetime).valueOf() / 1000; // Convert to epoch seconds
          logger.info(`RUMBLE: Last broadcast for ${username}: ${lastBroadcastDatetime}`);
        } else {
          logger.warn(`RUMBLE: Could not find last broadcast time for offline user ${username} using selector: ${lastBroadcastTimeSelector}. No recent videos or structure changed.`);
          result._lastBroadcastEpoch = 0; // Default to 0 if no valid timestamp
        }
        result.title = await safeQuery(page, `${firstVideoElement} h3.thumbnail__title`);
        const streamLinkElement = await safeAttr(page, `${firstVideoElement} a.thumbnail__link`, "href");
        if (streamLinkElement) {
          result.streamURL = streamLinkElement.startsWith("http") ? streamLinkElement : `https://rumble.com${streamLinkElement}`;
        }
      }
    } else {
      logger.warn(`RUMBLE: Video list container ('${videoListContainer}') not found for ${username}. Channel might have no videos listed.`);
      result._lastBroadcastEpoch = 0; // Default to 0 if no video list
    }
  } catch (e) {
    logger.error(`RUMBLE: General error scraping user ${username} (${basePath}): ${e.message},${e.stack}`);
    result.status = "error";
    result.error_details = e.message;
    result._isOnline = false;
    result._viewers = 0;
    result._lastBroadcastEpoch = 0;
  } finally {
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (e) {
        logger.error(`RUMBLE: Error closing page for ${username}: ${e.message}`);
      }
    }
  }
  return result;
}

/**
 * Scrapes all Rumble users from the predefined lists.
 * @returns {Promise<object[]>} Array of processed Rumble user data.
 */
async function scrapeAllRumbleUsers() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, // Use 'new' for new headless mode or true for old
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });

    const usersToScrape = [
      ...RUMBLE_USERS_CPATH.map((username) => ({
        username,
        basePath: "c"
      })),
      ...RUMBLE_USERS_USERPATH.map((username) => ({
        username,
        basePath: "user"
      })),
    ];

    let results = [];
    for (const {
        username,
        basePath
      } of usersToScrape) {
      logger.info(`RUMBLE: Starting scrape for ${username} (/${basePath}/)`);
      const data = await scrapeRumbleUser(browser, username, basePath);
      results.push(data);
    }
    return results;
  } catch (e) {
    logger.error(`RUMBLE: Failed to launch browser or critical error in scrapeAllRumbleUsers: ${e.message},${e.stack}`);
    return [];
  } finally {
    if (browser) {
      await browser.close();
      logger.info("RUMBLE: Browser closed.");
    }
  }
}

/**
 * Fetches user data from Trovo.
 * @param {string} username - The Trovo username.
 * @returns {Promise<object>} Processed Trovo user data.
 */
async function fetchTrovoUserData(username) {
  try {
    const trovoApi = axios.create({
      baseURL: TROVO_API_URL,
      headers: {
        "Client-ID": TROVO_CLIENT_ID,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    const response = await trovoApi.post("/channels/id", {
      username: username
    });
    const data = response.data;

    // Clean up profile pic URL
    const profilePic = data.profile_pic ? data.profile_pic.split("&")[0].split("?")[0] : null;

    const common = {
      platform: "trovo",
      username: data.username,
      user_name: data.username,
      profile_pic: profilePic,
      channel_url: data.channel_url || `https://trovo.live/${data.username}`,
    };

    if (data.is_live) {
      return {
        ...common,
        title: data.live_title || "",
        viewer_count: data.current_viewers || 0,
        _isOnline: true,
        _viewers: parseInt(data.current_viewers) || 0,
        _lastBroadcastEpoch: Math.floor(Date.now() / 1000), // Current time if live
      };
    } else {
      return {
        ...common,
        _isOnline: false,
        _viewers: 0,
        _lastBroadcastEpoch: data.ended_at ? Number(data.ended_at) : 0, // Use ended_at if available
      };
    }
  } catch (e) {
    logger.error(`Trovo API error fetching data for ${username}:`, e.response?.data || e.message);
    return {
      platform: "trovo",
      username: username,
      user_name: username,
      _isOnline: false,
      _viewers: 0,
      _lastBroadcastEpoch: 0, // Default to 0 on error
      error_details: `Trovo API Error: ${e.response?.data?.message || e.message}`
    };
  }
}

// --- Twitch API Handling ---
let twitchAccessToken = null;
let twitchTokenExpiry = 0; // Timestamp in milliseconds

/**
 * Gets a valid Twitch access token, refreshing if necessary.
 * @returns {Promise<string|null>} The Twitch access token or null on error.
 */
async function getTwitchAccessToken() {
  // Check if existing token is still valid
  if (twitchAccessToken && Date.now() < twitchTokenExpiry) {
    logger.debug("Twitch: Using existing valid access token.");
    return twitchAccessToken;
  }

  logger.info("Twitch: Attempting to obtain new access token...");
  try {
    const response = await axios.post(
      `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
    );
    twitchAccessToken = response.data.access_token;
    // Set expiry 1 minute before actual expiry to allow for refresh buffer
    twitchTokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
    logger.info("Twitch: Successfully obtained new access token.");
    return twitchAccessToken;
  } catch (e) {
    logger.error("Twitch: Error obtaining access token:", e.response?.data || e.message);
    return null;
  }
}

/**
 * Fetches Twitch user data for the given usernames.
 * @param {object} headers - Authorization headers for Twitch API.
 * @returns {Promise<object[]>} Array of Twitch user objects.
 */
async function getTwitchUsers(headers) {
  try {
    const MAX_USERS_PER_REQUEST = 100;
    let allUsers = [];
    for (let i = 0; i < TWITCH_USERNAMES.length; i += MAX_USERS_PER_REQUEST) {
      const batch = TWITCH_USERNAMES.slice(i, i + MAX_USERS_PER_REQUEST);
      const response = await axios.get("https://api.twitch.tv/helix/users", {
        headers: headers,
        params: {
          login: batch
        },
      });
      allUsers = allUsers.concat(response.data.data);
    }
    return allUsers;
  } catch (e) {
    logger.error(`Twitch: Error getting users: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
    return [];
  }
}

/**
 * Fetches Twitch stream data for the given user IDs.
 * @param {object} headers - Authorization headers for Twitch API.
 * @param {string[]} userIds - Array of Twitch user IDs.
 * @returns {Promise<object[]>} Array of Twitch stream objects.
 */
async function getTwitchStreams(headers, userIds) {
  try {
    const MAX_STREAMS_PER_REQUEST = 100;
    let allStreams = [];
    for (let i = 0; i < userIds.length; i += MAX_STREAMS_PER_REQUEST) {
      const batch = userIds.slice(i, i + MAX_STREAMS_PER_REQUEST);
      const response = await axios.get("https://api.twitch.tv/helix/streams", {
        headers: headers,
        params: {
          user_id: batch
        },
      });
      allStreams = allStreams.concat(response.data.data);
    }
    return allStreams;
  } catch (e) {
    logger.error(`Twitch: Error getting streams: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
    return [];
  }
}

/**
 * Fetches the latest video (archive) for given Twitch user IDs.
 * @param {object} headers - Authorization headers for Twitch API.
 * @param {string[]} userIds - Array of Twitch user IDs.
 * @returns {Promise<object[]>} Array of latest Twitch video objects.
 */
async function getTwitchLatestVideos(headers, userIds) {
  const latestVideos = [];
  for (const userId of userIds) {
    try {
      const response = await axios.get("https://api.twitch.tv/helix/videos", {
        headers: headers,
        params: {
          user_id: userId,
          first: 1, // Get only the latest one
          type: "archive", // Only recorded broadcasts
          sort: "time", // Sort by time (newest first)
        },
      });
      if (response.data.data.length > 0) {
        latestVideos.push(response.data.data[0]);
      }
    } catch (e) {
      logger.error(`Twitch: Error getting latest video for user ${userId}: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
    }
  }
  return latestVideos;
}

/**
 * Fetches and processes all Twitch data (live and offline).
 * @returns {Promise<object[]>} Array of processed Twitch user data.
 */
async function fetchTwitchData() {
  logger.info("TWITCH: Starting to fetch Twitch data...");
  try {
    const accessToken = await getTwitchAccessToken();
    if (!accessToken) {
      logger.error("TWITCH: Failed to get Twitch access token. Skipping Twitch data fetch.");
      return [];
    }

    const headers = {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    };

    const users = await getTwitchUsers(headers);
    if (!users || users.length === 0) {
      logger.warn("TWITCH: No user data returned from Twitch API.");
      return [];
    }

    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
    const userIds = users.map((u) => u.id);

    const streams = await getTwitchStreams(headers, userIds);
    const onlineUserIds = new Set(streams.map((s) => s.user_id));

    // Process online streams
    const onlineData = streams.map((s) => ({
      platform: "twitch",
      username: s.user_login,
      user_name: s.user_name,
      profile_image_url: userMap[s.user_id]?.profile_image_url,
      title: s.title,
      viewer_count: s.viewer_count,
      _isOnline: true, // Internal flag
      _viewers: parseInt(s.viewer_count) || 0, // Ensure numeric
      _lastBroadcastEpoch: Math.floor(new Date(s.started_at).getTime() / 1000), // Start time if live
    }));

    // Find offline users
    const offlineUserIds = userIds.filter((id) => !onlineUserIds.has(id));

    // Fetch latest videos for offline users
    let offlineData = [];
    if (offlineUserIds.length > 0) {
      offlineData = (await getTwitchLatestVideos(headers, offlineUserIds)).map((v) => ({
        platform: "twitch",
        username: v.user_login,
        user_name: v.user_name,
        profile_image_url: userMap[v.user_id]?.profile_image_url,
        last_broadcast_date: v.created_at,
        _isOnline: false, // Internal flag
        _viewers: 0,
        _lastBroadcastEpoch: v.created_at ? Math.floor(new Date(v.created_at).getTime() / 1000) : 0, // Last broadcast time if offline
      }));
    }

    logger.info(`TWITCH: Fetched ${onlineData.length} online and ${offlineData.length} offline Twitch users.`);
    return [...onlineData, ...offlineData];
  } catch (e) {
    logger.error(`TWITCH: General error fetching Twitch data: ${e.message}`);
    return [];
  }
}

/**
 * Scrapes YouTube live stream and channel data.
 * @returns {Promise<object[]>} Array of processed YouTube user data.
 */
async function fetchYouTubeData() {
  logger.info("YOUTUBE: Starting to fetch YouTube data...");
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new', // Use 'new' for the new headless mode
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
    );

    const results = [];

    for (const username of YOUTUBE_USERNAMES) {
      const url = `https://www.youtube.com/@${username}/streams`;
      logger.info(`YOUTUBE: Checking: ${url}`);
      let data = {
        platform: 'youtube',
        username: username,
        url: url,
        user_name: username, // Default, will be updated
        profile_image_url: 'N/A', // Consistent naming
        _isOnline: false, // Internal flag
        _viewers: 0, // Internal flag
        _lastBroadcastEpoch: 0, // Internal flag
        error_details: null,
      };

      try {
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 60000 // 60 seconds timeout
        });

        // Mimic slight random mouse movement
        await page.mouse.move(Math.random() * 100, Math.random() * 100);

        // Scrape display name
        data.user_name = await safeQuery(page, '#page-header yt-dynamic-text-view-model h1') || 'Unknown';

        // Scrape profile photo
        data.profile_image_url = await safeAttr(page, '#page-header img', 'src') || 'N/A';

        const isLiveElement = await page.$('#page-header yt-page-header-view-model .yt-spec-avatar-shape__live-badge');

        if (isLiveElement) {
          logger.info(`YOUTUBE: ${username} is LIVE`);
          data._isOnline = true;
          data._lastBroadcastEpoch = Math.floor(Date.now() / 1000); // Current time if live

          try {
            const titleElement = await page.$('#video-title');
            if (titleElement) {
              data.title = await page.evaluate(el => el.textContent.trim(), titleElement);
              data.live_link = await page.evaluate(el => el.href, titleElement); // Consistent naming

              // Click to open the live stream to get viewer count
              await titleElement.click();
              await new Promise(res => setTimeout(res, 15000)); // Wait for stream data to load

const viewerCountElement = await page.$('#view-count');
if (viewerCountElement) {
  const viewerCountText = await page.evaluate(el => el.getAttribute('aria-label'), viewerCountElement);
  const match = viewerCountText ? viewerCountText.match(/\d[\d,]*/) : null;
  data._viewers = match ? parseInt(match[0].replace(/,/g, ''), 10) : 0;
} else {
  data._viewers = 0;
}
              logger.info(`YOUTUBE: Retrieved viewer count for ${username}: ${data._viewers}`);
              await page.goBack({
                waitUntil: 'networkidle2'
              });
            } else {
              logger.warn(`YOUTUBE: Live stream title element not found for ${username}.`);
            }
          } catch (err) {
            logger.warn(`YOUTUBE: Error fetching live data for ${username}: ${err.message}`);
            data.error_details = (data.error_details ? data.error_details + '; ' : '') + `Live data fetch error: ${err.message}`;
          }
        } else {
          logger.info(`YOUTUBE: ${username} is OFFLINE`);
          data._isOnline = false;
          data._viewers = 0; // Not live, so 0 viewers

          try {
            // Selector for last broadcast date on the channel's /streams page
            const lastBroadcastElement = await page.$('ytd-grid-video-renderer:nth-child(1) #metadata-line span:nth-child(4)');
            if (lastBroadcastElement) {
              data.last_broadcast_text = await page.evaluate(el => el.textContent.trim(), lastBroadcastElement);
              // Use dayjs to parse and get epoch for sorting
              const parsedDate = dayjs(data.last_broadcast_text);
              if (parsedDate.isValid()) {
                data._lastBroadcastEpoch = parsedDate.valueOf() / 1000;
              } else {
                data._lastBroadcastEpoch = 0; // Default to 0 if parsing fails
              }
            } else {
              data.last_broadcast_text = 'Unknown';
              data._lastBroadcastEpoch = 0;
            }
          } catch (err) {
            logger.warn(`YOUTUBE: Error fetching last broadcast data for ${username}: ${err.message}`);
            data.last_broadcast_text = 'Unknown';
            data._lastBroadcastEpoch = 0;
            data.error_details = (data.error_details ? data.error_details + '; ' : '') + `Last broadcast data fetch error: ${err.message}`;
          }
        }
      } catch (e) {
        logger.error(`YOUTUBE: General error scraping ${username}: ${e.message},${e.stack}`);
        data.error_details = (data.error_details ? data.error_details + '; ' : '') + `General scraping error: ${e.message}`;
        data._isOnline = false;
        data._viewers = 0;
        data._lastBroadcastEpoch = 0;
      }
      results.push(data);
    }
    return results;
  } catch (e) {
    logger.error(`YOUTUBE: Failed to launch browser or critical error in fetchYouTubeData: ${e.message},${e.stack}`);
    return [];
  } finally {
    if (browser) {
      await browser.close();
      logger.info("YOUTUBE: Browser closed.");
    }
  }
}


/**
 * Fetches data from all supported streaming platforms concurrently.
 * Aggregates and processes the data for consistent sorting.
 * @returns {Promise<object[]>} Consolidated and sorted stream data.
 */
async function fetchAllStreamData() {
  logger.info("FETCH_ALL: Starting to fetch data from all platforms...");

  const [
    partiDataResult,
    vaughnDataResult,
    rumbleDataResult,
    twitchDataResult,
    trovoDataResult,
    youtubeDataResult // New YouTube data promise
  ] = await Promise.allSettled([
    Promise.all(USER_IDS_TO_CHECK.map(fetchPartiUserData)).catch(e => (logger.error("FETCH_ALL: Error fetching Parti data array:", e), [])),
    Promise.all(VAUGHN_USERNAMES.map(fetchVaughnStreamData)).catch(e => (logger.error("FETCH_ALL: Error fetching Vaughn data array:", e), [])),
    scrapeAllRumbleUsers().catch(e => (logger.error("FETCH_ALL: Error fetching Rumble data array:", e), [])),
    fetchTwitchData().catch(e => (logger.error("FETCH_ALL: Error fetching Twitch data array:", e), [])),
    Promise.all(TROVO_USERNAMES.map(fetchTrovoUserData)).catch(e => (logger.error("FETCH_ALL: Error fetching Trovo data array:", e), [])),
    fetchYouTubeData().catch(e => (logger.error("FETCH_ALL: Error fetching YouTube data array:", e), [])) // Call YouTube fetcher
  ]);

  const partiData = partiDataResult.status === "fulfilled" ? partiDataResult.value : [];
  const vaughnData = vaughnDataResult.status === "fulfilled" ? vaughnDataResult.value : [];
  const rumbleData = rumbleDataResult.status === "fulfilled" ? rumbleDataResult.value : [];
  const twitchData = twitchDataResult.status === "fulfilled" ? twitchDataResult.value : [];
  const trovoData = trovoDataResult.status === "fulfilled" ? trovoDataResult.value : [];
  const youtubeData = youtubeDataResult.status === "fulfilled" ? youtubeDataResult.value : []; // Get YouTube data

  logger.info(`FETCH_ALL: Fetched ${partiData.length} Parti, ${vaughnData.length} Vaughn, ${rumbleData.length} Rumble, ${twitchData.length} Twitch, ${trovoData.length} Trovo, ${youtubeData.length} YouTube users.`);
  logger.debug(`Raw Parti Data: ${JSON.stringify(partiData, null, 2).substring(0, 500)}...`);
  logger.debug(`Raw Vaughn Data: ${JSON.stringify(vaughnData, null, 2).substring(0, 500)}...`);
  logger.debug(`Raw Twitch Data: ${JSON.stringify(twitchData, null, 2).substring(0, 500)}...`);
  logger.debug(`Raw Rumble Data: ${JSON.stringify(rumbleData, null, 2).substring(0, 500)}...`);
  logger.debug(`Raw YouTube Data: ${JSON.stringify(youtubeData, null, 2).substring(0, 500)}...`);


  // Combine all data, filtering out any null/undefined entries
  const allData = [
    ...partiData,
    ...vaughnData,
    ...rumbleData,
    ...twitchData,
    ...trovoData,
    ...youtubeData // Add YouTube data
  ].filter(Boolean);

  logger.info(`FETCH_ALL: After initial aggregation and Boolean filter, allData has ${allData.length} entries.`);

  // Process and standardize data for sorting
  const filteredProcessedData = allData.map((entry) => {
    // Determine online status
    const isOnline = entry.is_live || entry.online || entry.status === "live" || entry._isOnline === true;
    let viewers = 0;
    if (isOnline) {
      viewers = parseInt(entry.viewer_count || entry.viewers || 0) || 0;
    }

    let lastBroadcastEpoch = 0;
    if (isOnline) {
      lastBroadcastEpoch = Math.floor(Date.now() / 1000); // If live, broadcast is happening now
    } else if (entry._last_broadcast_ts) { // For Parti
      lastBroadcastEpoch = entry._last_broadcast_ts;
    } else if (entry.lastlive_epoch) { // For Vaughn
      lastBroadcastEpoch = entry.lastlive_epoch;
    } else if (entry._lastBroadcastTimestamp) { // For Rumble (raw string)
      const date = new Date(entry._lastBroadcastTimestamp);
      if (!isNaN(date.getTime())) {
        lastBroadcastEpoch = Math.floor(date.getTime() / 1000);
      }
    } else if (entry._lastBroadcastEpoch) { // For Twitch/Trovo/YouTube (already epoch)
      lastBroadcastEpoch = entry._lastBroadcastEpoch;
    }

    let userName = entry.user_name || entry.username || entry.displayName || "N/A";
    if (entry.platform === "rumble" && entry.displayName) {
      userName = entry.displayName;
    }

    try {
      return {
        ...entry,
        user_name: userName,
        _isOnline: isOnline,
        _viewers: viewers,
        _lastBroadcastEpoch: lastBroadcastEpoch,
        platform: entry.platform || "unknown", // Ensure platform is set
      };
    } catch (processError) {
      logger.error(`Error processing user ${entry.username || entry.user_id}: ${processError.message}`, entry);
      return null;
    }
  }).filter(Boolean); // Filter out any entries that became null due to processing errors

  logger.info(`FETCH_ALL: After processing and filtering, filteredProcessedData has ${filteredProcessedData.length} entries.`);

  // Sort the combined data
  // Sort by ONLINE first (online users before offline users)
  // If both are online, sort by VIEWER COUNT (high to low)
  // If both are offline, sort by LAST BROADCAST (new to old)
  filteredProcessedData.sort((a, b) => {
    // Primary sort: Online vs. Offline
    if (a._isOnline && !b._isOnline) {
      return -1; // 'a' (online) comes before 'b' (offline)
    }
    if (!a._isOnline && b._isOnline) {
      return 1; // 'b' (online) comes before 'a' (offline)
    }

    // Secondary sort: If both are online, sort by viewer count (high to low)
    if (a._isOnline && b._isOnline) {
      return b._viewers - a._viewers;
    }

    // Tertiary sort: If both are offline, sort by last broadcast epoch (new to old)
    if (!a._isOnline && !b._isOnline) {
      return b._lastBroadcastEpoch - a._lastBroadcastEpoch;
    }

    // Should not reach here for correctly processed data, but for safety
    return 0;
  });

  // Map to final output format for data.json
  return filteredProcessedData.map((e) => {
    const output = {
      platform: e.platform,
      user_name: e.user_name,
      lastChecked: e.lastChecked || (new Date()).toISOString(),
    };

    if (e.platform === "parti") {
      Object.assign(output, {
        user_id: e.user_id,
        avatar_link: e.avatar_link,
        social_media: e.social_media,
        social_username: e.social_username,
        creator_url: e.creator_url,
        is_live: e._isOnline,
      });
      if (e._isOnline) {
        output.viewer_count = formatNumberWithCommas(e._viewers);
        output.event_name = e.event_name;
      } else {
        output.last_broadcast = e._lastBroadcastEpoch ? getRelativeTime(e._lastBroadcastEpoch) : "Unknown";
      }
    } else if (e.platform === "vaughn") {
      Object.assign(output, {
        username: e.username,
        profile_img: e.profile_img,
        online: e._isOnline,
      });
      if (e._isOnline) {
        output.status_msg = e.status_msg;
        output.viewers = formatNumberWithCommas(e._viewers);
      } else {
        output.last_live_relative = e._lastBroadcastEpoch ? getRelativeTime(e._lastBroadcastEpoch) : "Unknown";
      }
    } else if (e.platform === "rumble") {
      Object.assign(output, {
        username: e.username,
        basePath: e.basePath,
        profilePhoto: e.profilePhoto,
        status: e.status, // "live", "offline", "not_found", "error"
        url: e.url,
        streamURL: e.streamURL,
      });
      if (e.status === "live") {
        output.title = e.title;
        output.viewers = formatNumberWithCommas(e._viewers);
      } else if (e.status === "offline") {
        output.title = e.title;
        output.lastBroadcastDate = e._lastBroadcastEpoch ? getRelativeTime(e._lastBroadcastEpoch) : "Unknown";
      } else if (e.status === "not_found") {
        output.title = "User not found";
      }
    } else if (e.platform === "twitch") {
      Object.assign(output, {
        username: e.username,
        profile_image_url: e.profile_image_url,
        is_live: e._isOnline,
      });
      if (e._isOnline) {
        output.title = e.title;
        output.viewer_count = formatNumberWithCommas(e._viewers);
      } else {
        output.last_broadcast = e._lastBroadcastEpoch ? getRelativeTime(e._lastBroadcastEpoch) : "Unknown";
      }
    } else if (e.platform === "trovo") {
      Object.assign(output, {
        username: e.username,
        profile_pic: e.profile_pic,
        channel_url: e.channel_url,
        is_live: e._isOnline,
      });
      if (e._isOnline) {
        output.title = e.title;
        output.viewer_count = formatNumberWithCommas(e._viewers);
      } else {
        // Use dayjs fromNow for Trovo as it was already used in the original Trovo fetcher
        output.last_broadcast = e._lastBroadcastEpoch ? dayjs.unix(e._lastBroadcastEpoch).fromNow() : "Unknown";
      }
    } else if (e.platform === "youtube") { // YouTube specific output format
      Object.assign(output, {
        username: e.username,
        profile_image_url: e.profile_image_url,
        is_live: e._isOnline,
      });
      if (e._isOnline) {
        output.title = e.title || "No title found";
        output.live_link = e.live_link;
        output.viewer_count = formatNumberWithCommas(e._viewers);
      } else {
        output.last_broadcast = e._lastBroadcastEpoch ? getRelativeTime(e._lastBroadcastEpoch) : "Unknown";
        output.last_broadcast_text = e.last_broadcast_text; // Keep original text for debugging/info
      }
    }

    if (e.error_details) {
      output.error_details = e.error_details;
    }
    return output;
  });
}

// --- Data File Management ---
const OUTPUT_FILE = path.join(__dirname, "data.json");

/**
 * Updates the data.json file with the latest stream information.
 */
async function updateDataFile() {
  logger.info("CRON: Starting data update cycle...");
  try {
    const allProcessedData = (await fetchAllStreamData()).map((item) => {
      // Final pass to ensure "TBA" for missing last broadcast times where appropriate
      const result = { ...item
      };
      if (!result.is_live && !result.online && result.platform !== "rumble" && (result.last_broadcast === "Unknown" || result.last_broadcast === "Invalid date")) {
        result.last_broadcast = "TBA";
      } else if (result.platform === "rumble" && result.status === "offline" && (result.lastBroadcastDate === "Unknown" || result.lastBroadcastDate === "Invalid date")) {
        result.lastBroadcastDate = "TBA";
      }
      return result;
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProcessedData, null, 2));
    logger.info(`CRON: data.json updated successfully with ${allProcessedData.length} entries.`);
  } catch (e) {
    logger.error(`CRON: Failed to update data.json: ${e.message},${e.stack}`);
  }
}

// --- Scheduler and Server Startup ---

// Schedule data update every 1 minute
cron.schedule("*/1 * * * *", () => {
  logger.info("CRON: Triggering scheduled data update...");
  updateDataFile();
});

// Perform initial data fetch and write on startup
(async () => {
  logger.info("STARTUP: Performing initial data fetch and write...");
  await updateDataFile();
})();

const app = express(),
  PORT = process.env.PORT || 3e3;

app.use(express.static(path.join(__dirname, "public")));

// API endpoint to serve the data.json file
app.get("/api/data", async (req, res) => {
  const filePath = path.join(__dirname, "data.json");
  fs.existsSync(filePath) ?
    res.sendFile(filePath, (err) => {
      if (err) {
        logger.error(`API: Error sending data.json file: ${err.message}`);
        // Only send status if headers haven't been sent
        if (!res.headersSent) {
          res.status(500).json({
            error: "Failed to send data file."
          });
        }
      } else {
        logger.info("API: data.json successfully served.");
      }
    }) :
    (() => {
      logger.error("API: data.json not found for /api/data request. It might be updating or failed to generate.");
      if (!res.headersSent) {
        res.status(404).json({
          error: "Data file not found. It might be updating. Please try again shortly."
        });
      }
    })();
});

// Serve the index.html file for the root path
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the Express server
app.listen(PORT, () => {
  logger.info(`SERVER: Express server is running and listening on http://localhost:${PORT}`);
  logger.info(`SERVER: API endpoint available at http://localhost:${PORT}/api/data`);
  logger.info(`SERVER: Frontend served from 'public' directory (e.g., http://localhost:${PORT}/index.html)`);
});
