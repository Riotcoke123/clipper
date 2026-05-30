'use strict';

require('dotenv').config();

const express  = require('express');
const { spawn } = require('child_process');
const ffmpeg   = require('fluent-ffmpeg');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const Database = require('better-sqlite3');

/* ============================================================
   CONFIG
   ============================================================ */
const CLIP_OUTPUT_DIR    = process.env.CLIP_OUTPUT_DIR  || path.join(__dirname, 'public', 'clips');
const CLIP_TEMP_DIR      = process.env.CLIP_TEMP_DIR    || path.join(__dirname, 'temp');
const KICK_API_BASE      = process.env.KICK_API_BASE    || 'https://api.kick.com';
const KICK_AUTH_BASE     = process.env.KICK_AUTH_BASE   || 'https://id.kick.com';
const KICK_WEB_BASE      = process.env.KICK_WEB_BASE    || 'https://kick.com';
const KICK_CLIENT_ID     = process.env.KICK_CLIENT_ID   || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const TWITCH_WEB_BASE    = process.env.TWITCH_WEB_BASE  || 'https://www.twitch.tv';
const YOUTUBE_API_BASE   = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_API_KEY    = process.env.YOUTUBE_API_KEY  || '';
const CATBOX_USERHASH    = process.env.CATBOX_USERHASH  || '';
const VIDEY_API_KEY      = process.env.VIDEY_API_KEY    || '';
const VIDEY_API_SECRET   = process.env.VIDEY_API_SECRET || '';
const MAX_CLIP_SECONDS   = Number(process.env.MAX_CLIP_SECONDS)  || 300;
const DEFAULT_CLIP_SECS  = Number(process.env.DEFAULT_CLIP_SECS) || 60;
const DB_PATH            = process.env.DB_PATH || path.join(__dirname, 'clipper.db');
const FFMPEG_THREADS     = Number(process.env.FFMPEG_THREADS)         || 0; // 0 = ffmpeg auto
const YTDLP_CONCURRENT_FRAGS = Number(process.env.YTDLP_CONCURRENT_FRAGS) || 1;
const USER_AGENT         = process.env.USER_AGENT || '';

/* ── Security ─────────────────────────────────────────────── */
// Set CLIPPER_API_KEY in your environment to require an Authorization header
// on every mutating request (POST, DELETE).  Server will refuse to start without it.
const API_KEY = process.env.CLIPPER_API_KEY || '';
if (!API_KEY || API_KEY.length < 32) {
  console.error(
    '[Clipper] FATAL: CLIPPER_API_KEY must be set to a string of at least 32 characters.\n' +
    '         Generate one with: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\')|0 && process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

// Separate browser-facing key so the real CLIPPER_API_KEY (admin-level) is
// never sent to the browser.  Set CLIPPER_BROWSER_KEY in your .env to a
// different value; if omitted it falls back to CLIPPER_API_KEY so existing
// deployments keep working without any changes.
const BROWSER_KEY = process.env.CLIPPER_BROWSER_KEY || API_KEY;

// In-memory session store: token → expiresAt (ms)
// Sessions last 8 hours; they are also pruned every 30 minutes.
const SESSION_TTL_MS = 8 * 3_600_000;
const _sessions      = new Map(); // token → expiresAt

function createSession() {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  _sessions.set(token, expiresAt);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const exp = _sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { _sessions.delete(token); return false; }
  return true;
}

// Prune expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of _sessions) { if (now > exp) _sessions.delete(t); }
}, 30 * 60_000).unref();


// How long to keep completed clip files on disk before auto-deleting.
// Keeps disk usage bounded with multiple users.  Override with CLIP_MAX_AGE_HOURS.
const CLIP_MAX_AGE_MS    = (Number(process.env.CLIP_MAX_AGE_HOURS) || 1) * 3_600_000;

// Maximum simultaneous capture jobs (yt-dlp + ffmpeg processes).
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 5;

// Simple in-memory rate limiter: max requests per window per IP.
const RATE_LIMIT_WINDOW_MS  = Number(process.env.RATE_LIMIT_WINDOW_MS)  || 60_000; // 1 min
// POST /clip: how many new clip jobs each IP can start per window.
const RATE_LIMIT_MAX_CLIPS  = Number(process.env.RATE_LIMIT_MAX_CLIPS)  || 5;
// GET poll/status endpoints: much higher ceiling so polling every 2 s never
// triggers a 429 even with 5 simultaneous users on the same IP.
const RATE_LIMIT_MAX_POLLS  = Number(process.env.RATE_LIMIT_MAX_POLLS)  || 300;

// Allowed HTTPS hostnames for user-supplied stream URLs (SSRF guard).
// Add more if you need to support additional platforms.
const ALLOWED_STREAM_HOSTS = new Set([
  'www.youtube.com', 'youtube.com', 'm.youtube.com',
  'www.twitch.tv',   'twitch.tv',
  'kick.com',        'www.kick.com',  'm.kick.com',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_PLATFORMS = ['youtube', 'twitch', 'kick'];
const VALID_QUALITIES  = ['low', 'medium', 'high'];

/* Ensure directories exist */
[CLIP_OUTPUT_DIR, CLIP_TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ============================================================
   JOB STORE  (SQLite-backed)
   ============================================================ */

/**
 * @typedef {Object} ClipJob
 * @property {string}  id
 * @property {string}  platform
 * @property {string}  username
 * @property {number}  duration
 * @property {'pending'|'resolving'|'capturing'|'encoding'|'ready'|'error'} status
 * @property {number}  progress       0–100
 * @property {string|null} outputFile absolute path to finished mp4
 * @property {string|null} downloadUrl relative URL the client can use
 * @property {string|null} error
 * @property {string}  createdAt      ISO timestamp
 */

const db = new Database(DB_PATH);

// WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    platform    TEXT NOT NULL,
    username    TEXT NOT NULL,
    duration    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    progress    INTEGER NOT NULL DEFAULT 0,
    outputFile  TEXT,
    downloadUrl TEXT,
    error       TEXT,
    createdAt   TEXT NOT NULL,
    startOffset INTEGER NOT NULL DEFAULT 0
  )
`);

// Add startOffset column to existing DBs that pre-date this migration
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN startOffset INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists — ignore */ }

/* ── Clipped-users registry ───────────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS clipped_users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    username         TEXT    NOT NULL,
    platform         TEXT    NOT NULL,
    url              TEXT,
    clip_count       INTEGER NOT NULL DEFAULT 1,
    total_duration   INTEGER NOT NULL DEFAULT 0,
    first_clipped_at TEXT    NOT NULL,
    last_clipped_at  TEXT    NOT NULL,
    UNIQUE (username, platform)
  )
`);

// Add url column to existing DBs that pre-date this migration
try {
  db.exec(`ALTER TABLE clipped_users ADD COLUMN url TEXT`);
} catch (_) { /* column already exists — ignore */ }

/* ── Per-platform aggregate stats ────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_stats (
    platform         TEXT PRIMARY KEY,
    clip_count       INTEGER NOT NULL DEFAULT 0,
    total_duration   INTEGER NOT NULL DEFAULT 0,
    unique_users     INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT    NOT NULL
  )
`);

/* ── Prepared statements for user/platform tracking ─────── */
const stmtUpsertUser = db.prepare(`
  INSERT INTO clipped_users (username, platform, url, clip_count, total_duration, first_clipped_at, last_clipped_at)
  VALUES (@username, @platform, @url, 1, @duration, @now, @now)
  ON CONFLICT(username, platform) DO UPDATE SET
    clip_count     = clip_count + 1,
    total_duration = total_duration + @duration,
    url            = COALESCE(@url, url),
    last_clipped_at = @now
`);

const stmtUpsertPlatform = db.prepare(`
  INSERT INTO platform_stats (platform, clip_count, total_duration, unique_users, last_activity_at)
  VALUES (@platform, 1, @duration, 1, @now)
  ON CONFLICT(platform) DO UPDATE SET
    clip_count       = clip_count + 1,
    total_duration   = total_duration + @duration,
    unique_users     = (SELECT COUNT(DISTINCT username) FROM clipped_users WHERE platform = @platform),
    last_activity_at = @now
`);

const stmtAllUsers     = db.prepare('SELECT * FROM clipped_users ORDER BY last_clipped_at DESC');
const stmtUsersByPlat  = db.prepare('SELECT * FROM clipped_users WHERE platform = ? ORDER BY last_clipped_at DESC');
const stmtAllPlatStats = db.prepare('SELECT * FROM platform_stats ORDER BY clip_count DESC');

/**
 * Record a successfully completed clip into the users + platform registries.
 * Called once a job transitions to 'ready'.
 */
const recordClipCompletion = db.transaction((username, platform, duration, url = null) => {
  const now = new Date().toISOString();
  stmtUpsertUser.run({ username, platform, url, duration, now });
  stmtUpsertPlatform.run({ platform, duration, now });
});

// Prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO jobs (id, platform, username, duration, status, progress, outputFile, downloadUrl, error, createdAt, startOffset)
  VALUES (@id, @platform, @username, @duration, @status, @progress, @outputFile, @downloadUrl, @error, @createdAt, @startOffset)
`);

const stmtSelectOne = db.prepare('SELECT * FROM jobs WHERE id = ?');

const stmtUpdate = db.prepare(`
  UPDATE jobs
  SET status      = COALESCE(@status,      status),
      progress    = COALESCE(@progress,    progress),
      outputFile  = COALESCE(@outputFile,  outputFile),
      downloadUrl = COALESCE(@downloadUrl, downloadUrl),
      error       = COALESCE(@error,       error),
      startOffset = COALESCE(@startOffset, startOffset)
  WHERE id = @id
`);

const stmtDelete  = db.prepare('DELETE FROM jobs WHERE id = ?');
const stmtCount   = db.prepare('SELECT COUNT(*) AS n FROM jobs');
const stmtRecent  = db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC LIMIT 100');

/** Parse a raw DB row back into a ClipJob (coerce integer progress). */
function rowToJob(row) {
  if (!row) return null;
  return { ...row, progress: Number(row.progress), duration: Number(row.duration) };
}

/**
 * Thin compatibility shim so the rest of the file can still call
 * jobs.get / jobs.set / jobs.delete / jobs.values / jobs.size.
 */
const jobs = {
  get:    (id)       => rowToJob(stmtSelectOne.get(id)),
  set:    (_id, job) => stmtInsert.run(job),   // only used by createJob
  delete: (id)       => { stmtDelete.run(id); },
  values: ()         => stmtRecent.all().map(rowToJob),
  get size()         { return stmtCount.get().n; },
};

function createJob(platform, username, duration) {
  const id = uuidv4();
  /** @type {ClipJob} */
  const job = {
    id,
    platform,
    username,
    duration,
    status: 'pending',
    progress: 0,
    outputFile: null,
    downloadUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
    startOffset: 0,
  };
  stmtInsert.run(job);
  return job;
}

function updateJob(id, patch) {
  stmtUpdate.run({
    id,
    status:      patch.status      ?? null,
    progress:    patch.progress    ?? null,
    outputFile:  patch.outputFile  ?? null,
    downloadUrl: patch.downloadUrl ?? null,
    error:       patch.error       ?? null,
    startOffset: patch.startOffset ?? null,
  });
}

/* ── Auto-cleanup of old clips ────────────────────────────── */
/**
 * Delete clips (file + DB row) older than CLIP_MAX_AGE_HOURS.
 * Runs at startup and every 30 minutes so disk stays bounded
 * when multiple users are clipping throughout the day.
 */
function cleanupOldClips() {
  const cutoff = new Date(Date.now() - CLIP_MAX_AGE_MS).toISOString();
  const stale  = db.prepare(
    "SELECT id, outputFile FROM jobs WHERE createdAt < ? AND status IN ('ready','error','pending')"
  ).all(cutoff);

  for (const row of stale) {
    if (row.outputFile) fs.unlink(row.outputFile, () => {});
    // Remove any temp raw file left by an interrupted job
    fs.unlink(path.join(CLIP_TEMP_DIR, `raw_${row.id}.mp4`), () => {});
    stmtDelete.run(row.id);
  }

  if (stale.length > 0) {
    console.log(`[Clipper] Auto-cleanup: removed ${stale.length} stale clip(s) (>= ${process.env.CLIP_MAX_AGE_HOURS || 1}h old)`);
  }
}

// Run immediately on startup, then every 30 minutes
cleanupOldClips();
setInterval(cleanupOldClips, 30 * 60_000).unref();

/**
 * Sanitise a channel handle / username:
 *  - strip leading/trailing whitespace
 *  - cap length at 128 chars
 *  - remove characters that are illegal in filenames or HTTP headers
 */
function sanitizeUsername(raw) {
  if (typeof raw !== 'string') throw new Error('username must be a string');
  const s = raw.trim();
  if (!s) throw new Error('username is empty');
  if (s.length > 128) throw new Error('username too long (max 128 chars)');
  // Keep word chars, @, :, ., /, -, and URL query-string chars (?, =, &) — everything else becomes _
  return s.replace(/[^\w@:./?=&-]/g, '_');
}

/**
 * SSRF guard — if the caller supplied a full URL, ensure it points to one of
 * the known-good streaming hostnames and uses HTTPS.
 */
function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed (got ${parsed.protocol})`);
  }
  if (!ALLOWED_STREAM_HOSTS.has(parsed.hostname)) {
    throw new Error(`URL hostname not allowed: ${parsed.hostname}`);
  }
}

/**
 * Validate that a jobId looks like a v4 UUID before hitting the DB.
 */
function assertValidJobId(id) {
  if (!UUID_RE.test(id)) {
    const err = new Error('Invalid job ID');
    err.status = 400;
    throw err;
  }
}

/**
 * Escape a value for use in a Content-Disposition filename parameter.
 */
function safeFilename(name) {
  return '"' + name.replace(/[\\"/\r\n]/g, '_') + '"';
}

/**
 * Derive a short, filesystem-safe label from a username or stream URL.
 * Full URLs like https://www.youtube.com/watch?v=XJ3Je8RxOiY are collapsed
 * to just the meaningful identifier (video ID, channel slug, etc.) so that
 * generated filenames stay readable.
 */
function shortLabel(raw) {
  try {
    const u = new URL(raw);
    // YouTube watch URLs → video ID
    const v = u.searchParams.get('v');
    if (v) return v.replace(/[^\w-]/g, '_');
    // Any other URL → last non-empty path segment
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return seg.replace(/[^\w@.-]/g, '_').slice(0, 40);
  } catch (_) { /* not a URL — fall through */ }
  // Plain username — strip URL-like chars that crept in via sanitizeUsername
  return raw.replace(/[^\w@.-]/g, '_').slice(0, 40);
}

/**
 * Given a full stream URL, return the human-readable username/channel identifier.
 * Falls back to the raw input if it isn't a recognisable URL.
 *
 * Examples:
 *   YouTube  https://www.youtube.com/@mkbhd/live  → "mkbhd"
 *   YouTube  https://www.youtube.com/watch?v=ABC  → "ABC"  (video ID)
 *   Twitch   https://www.twitch.tv/xqc            → "xqc"
 *   Kick     https://kick.com/xqc                 → "xqc"
 */
function extractUsernameFromUrl(raw, platform) {
  if (typeof raw !== 'string' || !raw.startsWith('http')) return raw;

  let parsed;
  try { parsed = new URL(raw); } catch (_) { return raw; }

  const hostname = parsed.hostname.replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
    // watch?v=VIDEO_ID
    const v = parsed.searchParams.get('v');
    if (v) return v;
    // /@handle or /@handle/live
    const handle = segments.find(s => s.startsWith('@'));
    if (handle) return handle.slice(1); // strip leading @
    // /channel/CHANNEL_ID or /c/name
    if (segments.length >= 2 && ['channel', 'c', 'user'].includes(segments[0])) return segments[1];
    if (segments[0]) return segments[0];
  }

  if (hostname === 'twitch.tv') {
    // https://www.twitch.tv/<channel>
    if (segments[0]) return segments[0];
  }

  if (hostname === 'kick.com') {
    // https://kick.com/<slug>
    if (segments[0]) return segments[0];
  }

  // Generic fallback: last non-empty path segment
  return segments[segments.length - 1] || raw;
}


/**
 * Removes `outputFile` (absolute disk path) to avoid filesystem disclosure.
 */
function publicJob(job) {
  if (!job) return null;
  const { outputFile: _omit, ...rest } = job;
  return rest;
}

/* ── Simple in-memory rate limiter (per-IP, configurable ceiling) ── */
const _rateBuckets = new Map(); // `${ip}:${key}` → { count, resetAt }

/**
 * Build a rate-limit middleware with a specific ceiling.
 * Using a key lets clip-creation and poll requests share the same bucket
 * map but maintain independent counters per IP.
 */
function makeRateLimiter(maxReq, bucketKey = 'default') {
  return function rateLimitMiddleware(req, res, next) {
    const ip    = req.ip || req.socket?.remoteAddress || 'unknown';
    const bkey  = `${ip}:${bucketKey}`;
    const now   = Date.now();
    let bucket  = _rateBuckets.get(bkey);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      _rateBuckets.set(bkey, bucket);
    }
    bucket.count++;
    if (bucket.count > maxReq) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}

// Strict: limits how many new clip jobs an IP can start per minute.
const clipCreationLimiter = makeRateLimiter(RATE_LIMIT_MAX_CLIPS, 'clip');
// Loose: high enough that polling every 2 s across 5 active jobs never hits it.
const pollLimiter         = makeRateLimiter(RATE_LIMIT_MAX_POLLS, 'poll');

// Prune stale buckets periodically to avoid memory growth
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of _rateBuckets) { if (now > b.resetAt) _rateBuckets.delete(k); }
}, 300_000).unref();

/* ── API-key guard (always enforced) ─────────────────────── */
function apiKeyMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  // Accept server-side API key (Bearer) for programmatic/admin access.
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (bearerToken && (bearerToken === API_KEY || bearerToken === BROWSER_KEY)) {
    return next();
  }
  // Also accept a browser session token (Session <token>) issued by /config.
  // This keeps the real API key off the wire entirely.
  const sessionToken = authHeader.startsWith('Session ') ? authHeader.slice(8).trim() : '';
  if (sessionToken && isValidSession(sessionToken)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized — valid API key or session required' });
}

/* ── Active-job concurrency counter ──────────────────────── */
let _activeJobs = 0;

/* ============================================================
   PLATFORM: STREAM-URL RESOLVERS
   ============================================================ */

/**
 * YouTube — uses the Data API to resolve a handle to a live video ID,
 * then returns type:'ytdlp' with the direct watch?v= URL.
 *
 * The yt-dlp download path uses player_client=android which hits YouTube's InnerTube API
 * mobile innertube API and avoids the [youtube:tab] channel-page scraper
 * that 404s when the live tab is absent or the video is unlisted.
 */
async function resolveYouTube(username) {
  if (username.startsWith('http')) {
    assertSafeUrl(username);
    // Fall through with this as watchUrl so it gets the same HLS pre-resolution below.
    const watchUrl = username;
    try {
      const hlsUrl = await ytDlpGetUrl(watchUrl, [
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best',
      ]);
      console.log(`[YouTube] Resolved HLS URL for ${watchUrl}`);
      return { type: 'hls', url: hlsUrl };
    } catch (err) {
      console.warn(`[YouTube] --get-url failed (${err.message}), falling back to ytdlp mode`);
      return { type: 'ytdlp', url: watchUrl };
    }
  }

  const handle = username.replace(/^@/, '');
  let watchUrl = null;

  if (YOUTUBE_API_KEY) {
    try {
      const chRes = await fetch(
        `${YOUTUBE_API_BASE}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${YOUTUBE_API_KEY}`
      );
      if (chRes.ok) {
        const channelId = (await chRes.json())?.items?.[0]?.id;
        if (channelId) {
          const srRes = await fetch(
            `${YOUTUBE_API_BASE}/search?part=id&channelId=${encodeURIComponent(channelId)}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`
          );
          if (srRes.ok) {
            const videoId = (await srRes.json())?.items?.[0]?.id?.videoId;
            if (videoId) {
              console.log(`[YouTube] Data API: @${handle} -> watch?v=${videoId}`);
              watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[YouTube] Data API failed (${err.message})`);
    }
  }

  if (!watchUrl) {
    console.warn(`[YouTube] Falling back to @${handle}/live`);
    watchUrl = `https://www.youtube.com/@${encodeURIComponent(handle)}/live`;
  }

  // Pre-resolve to a direct HLS manifest URL.
  //
  // Reasons:
  //  1. Avoids the [youtube:tab] channel-page scraper entirely — ios+web player
  //     clients hit YouTube's innertube API directly and work even when the tab
  //     endpoint 404s.
  //  2. Lets captureClip use ffmpeg -t (reliable live clipping) instead of
  //     yt-dlp --download-sections (designed for VODs, unreliable on live HLS).
  try {
    const hlsUrl = await ytDlpGetUrl(watchUrl, [
      '--extractor-args', 'youtube:player_client=android',
      '--format', 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best',
    ]);
    console.log(`[YouTube] Resolved HLS URL for ${watchUrl}`);
    return { type: 'hls', url: hlsUrl };
  } catch (err) {
    // Last-ditch fallback: hand the page URL to yt-dlp and let it figure it out.
    console.warn(`[YouTube] --get-url failed (${err.message}), falling back to ytdlp mode`);
    return { type: 'ytdlp', url: watchUrl };
  }
}

/**
 * Twitch — pre-resolve to a direct HLS URL so captureClip can use
 * ffmpeg -t (live-edge clipping) instead of yt-dlp --download-sections.
 */
async function resolveTwitch(username) {
  const handle = encodeURIComponent(username.replace(/^https?:\/\/[^/]+\//i, '').split('/')[0]);
  const pageUrl = `${TWITCH_WEB_BASE}/${handle}`;
  try {
    const hlsUrl = await ytDlpGetUrl(pageUrl, ['--format', 'best[protocol^=m3u8]/best']);
    console.log(`[Twitch] Resolved HLS URL for ${handle}`);
    return { type: 'hls', url: hlsUrl };
  } catch (err) {
    console.warn(`[Twitch] --get-url failed (${err.message}), falling back to ytdlp mode`);
    return { type: 'ytdlp', url: pageUrl };
  }
}

async function resolveKick(username) {
  let slug;
  if (username.startsWith('http')) {
    assertSafeUrl(username);
    slug = new URL(username).pathname.replace(/^\//, '').split('/')[0];
  } else {
    slug = username.replace(/^@/, '').split('/')[0].trim();
  }
  const pageUrl = `${KICK_WEB_BASE}/${encodeURIComponent(slug)}`;
  try {
    const hlsUrl = await ytDlpGetUrl(pageUrl, ['--format', 'best[protocol^=m3u8]/best']);
    console.log(`[Kick] Resolved HLS URL for ${slug}`);
    return { type: 'hls', url: hlsUrl };
  } catch (err) {
    console.warn(`[Kick] --get-url failed (${err.message}), falling back to ytdlp mode`);
    return { type: 'ytdlp', url: pageUrl };
  }
}


/* ============================================================
   yt-dlp HELPER  — get a direct stream URL without downloading
   ============================================================ */

/**
 * Runs yt-dlp --get-url and resolves with the first URL printed.
 */
function ytDlpGetUrl(pageUrl, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      '--get-url',
      '--no-playlist',
      ...(USER_AGENT ? ['--user-agent', USER_AGENT] : []),
      ...extraArgs,
      pageUrl,
    ];
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      const url = stdout.trim().split('\n')[0];
      if (code !== 0 || !url) {
        reject(new Error(`yt-dlp failed (${code}): ${stderr.trim().slice(0, 200)}`));
      } else {
        resolve(url);
      }
    });
    proc.on('error', err => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
  });
}

/* ============================================================
   CLIPPING ENGINE
   ============================================================ */

/**
 * Unified platform dispatcher — returns { type, url } for a live stream.
 */
async function resolveStreamUrl(platform, username) {
  const p = platform.toLowerCase();
  switch (p) {
    case 'youtube': return resolveYouTube(username);
    case 'twitch':  return resolveTwitch(username);
    case 'kick':    return resolveKick(username);
    default:        throw new Error(`Unsupported platform: "${platform}"`);
  }
}

/**
 * Cut a clip from an HLS or FLV stream.
 *
 * For HLS streams we use yt-dlp (handles manifests, retries, auth).
 * For FLV we pipe ffmpeg directly — yt-dlp can't download raw FLV by time.
 *
 * @param {string} jobId
 * @param {{ type: 'hls'|'flv'|'ytdlp', url: string }} stream
 * @param {number} duration  seconds
 * @param {'low'|'medium'|'high'} quality
 * @returns {Promise<string>} absolute path to the finished mp4
 */
async function captureClip(jobId, stream, duration, quality = 'medium', startOffset = 0) {
  const outFile = path.join(CLIP_OUTPUT_DIR, `clip_${jobId}.mp4`);
  const tempRaw = path.join(CLIP_TEMP_DIR, `raw_${jobId}`);

  if (stream.type === 'flv' || stream.type === 'hls') {
    // --- Direct-URL path: feed stream URL straight into ffmpeg ---
    // Covers:
    //   'flv'  — raw FLV CDN streams
    //   'hls'  — m3u8 URLs resolved via platform APIs or yt-dlp --get-url
    //            ffmpeg's own HTTP stack is used, bypassing libcurl entirely.
    return new Promise((resolve, reject) => {
      updateJob(jobId, { status: 'capturing', progress: 5 });

      const sizeFilter = quality === 'low'  ? '640:-2'
                       : quality === 'high' ? '1280:-2'
                       : '854:-2';

      // -live_start_index 0  → read from the oldest available HLS segment (DVR buffer)
      // -ss startOffset      → jump forward by the seconds lost to URL resolution,
      //                        so the captured content begins at the moment the user
      //                        clicked "Capture" rather than when ffmpeg finally started.
      const inputOptions = [
        // Reconnect on dropped segments — essential for live HLS
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // Seek into the DVR buffer to the click moment
        '-live_start_index', '0',
      ];
      if (startOffset > 0) {
        inputOptions.push('-ss', String(startOffset));
      }
      inputOptions.push('-t', String(duration));

      // Track last written progress so we never go backwards
      let lastPct = 5;

      ffmpeg(stream.url)
        .inputOptions(inputOptions)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('128k')
        .videoFilter(`scale=${sizeFilter}`)
        .outputOptions([
          '-preset veryfast',
          '-movflags +faststart',
          '-avoid_negative_ts make_zero',
          ...(FFMPEG_THREADS > 0 ? [`-threads ${FFMPEG_THREADS}`] : []),
        ])
        .output(outFile)
        .on('progress', prog => {
          // prog.percent is always 0 for live streams (no known total duration).
          // Derive real progress from timemark (HH:MM:SS.ms) instead.
          // Only update when we have a real timemark AND progress moves forward.
          if (!prog.timemark) return;
          const p = prog.timemark.split(':');
          const secs = (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2] || 0);
          if (secs <= 0) return;
          const pct = Math.min(95, Math.round((secs / duration) * 100));
          if (pct <= lastPct) return;           // never go backwards
          lastPct = pct;
          updateJob(jobId, { status: 'capturing', progress: pct });
        })
        .on('end', () => {
          updateJob(jobId, { status: 'ready', progress: 100, outputFile: outFile });
          resolve(outFile);
        })
        .on('error', err => {
          updateJob(jobId, { status: 'error', error: err.message });
          reject(err);
        })
        .run();
    });
  }

  // --- HLS / yt-dlp path: yt-dlp download → ffmpeg re-encode ---
  const formatArg = quality === 'low'
    ? 'worst[protocol^=m3u8][height>=360]/worst[protocol^=m3u8]/worst[height>=360]/worst'
    : quality === 'high'
    ? 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best[height<=1080]/best'
    : 'best[protocol^=m3u8][height<=720]/best[protocol^=m3u8]/best[height<=720]/best';

  const tempFile = `${tempRaw}.mp4`;

  await new Promise((resolve, reject) => {
    updateJob(jobId, { status: 'capturing', progress: 2 });

    // startOffset shifts the section window to match the click time:
    // *startOffset-(startOffset+duration) captures the segment that was live
    // when the user pressed Capture, not when URL resolution finished.
    const sectionStart = startOffset;
    const sectionEnd   = startOffset + duration;

    const args = [
      '--no-playlist',
      '--socket-timeout', '20',
      '--retries', '3',
      '--fragment-retries', '3',
      '--concurrent-fragments', String(YTDLP_CONCURRENT_FRAGS),
      ...(USER_AGENT ? ['--user-agent', USER_AGENT] : []),
      '--format', formatArg,
      // android player_client uses InnerTube without requiring a PO Token,
      // which ios and web both now demand on VPS/datacenter IPs.
      '--extractor-args', 'youtube:player_client=android',
      '--downloader', 'native',
      '--download-sections', `*${sectionStart}-${sectionEnd}`,
      '-o', tempFile,
      stream.url,
    ];

    const proc = spawn('yt-dlp', args);
    let stderr = '';
    let lastDlPct = 2; // never let progress go backwards

    proc.stdout.on('data', data => {
      const out = data.toString();
      const m = out.match(/(\d+\.?\d*)%/);
      if (m) {
        // Map download progress to 2–70%
        const pct = Math.round(2 + Math.min(68, parseFloat(m[1]) * 0.68));
        if (pct > lastDlPct) {
          lastDlPct = pct;
          updateJob(jobId, { progress: pct });
        }
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 2000)}`));
      else resolve();
    });
    proc.on('error', err => reject(new Error(`yt-dlp spawn: ${err.message}`)));
  });

  // Re-encode to normalised mp4
  await new Promise((resolve, reject) => {
    updateJob(jobId, { status: 'encoding', progress: 72 });

    const sizeFilter = quality === 'low'  ? '640:-2'
                     : quality === 'high' ? '1280:-2'
                     : '854:-2';

    let lastEncPct = 72; // never go backwards during encode

    ffmpeg(tempFile)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .videoFilter(`scale=${sizeFilter}`)
      .outputOptions([
        '-preset veryfast',
        '-movflags +faststart',
        ...(FFMPEG_THREADS > 0 ? [`-threads ${FFMPEG_THREADS}`] : []),
      ])
      .output(outFile)
      .on('progress', prog => {
        const pct = Math.round(72 + Math.min(23, (prog.percent || 0) * 0.23));
        if (pct > lastEncPct) {
          lastEncPct = pct;
          updateJob(jobId, { progress: pct });
        }
      })
      .on('end', () => {
        // Cleanup temp file
        fs.unlink(tempFile, () => {});
        updateJob(jobId, { status: 'ready', progress: 100, outputFile: outFile });
        resolve();
      })
      .on('error', err => {
        fs.unlink(tempFile, () => {});
        updateJob(jobId, { status: 'error', error: err.message });
        reject(err);
      })
      .run();
  });

  return outFile;
}

/* ============================================================
   PUBLIC API — start a clip job
   ============================================================ */

/**
 * Start a clip job asynchronously. Returns the job object immediately.
 *
 * @param {Object} opts
 * @param {string} opts.platform   'youtube'|'twitch'|'kick'
 * @param {string} [opts.url]      full stream URL (preferred; username extracted automatically)
 * @param {string} [opts.username] channel handle / URL (legacy; use url instead)
 * @param {number} [opts.duration] seconds to capture (capped at MAX_CLIP_SECONDS)
 * @param {'low'|'medium'|'high'} [opts.quality]
 * @returns {ClipJob}
 */
function startClip({ platform, url, username, duration, quality = 'medium', rewindOffset = 0 }) {
  // Accept either `url` (new) or `username` (legacy) — `url` takes precedence.
  const rawInput = url || username;
  if (!platform || !rawInput) throw new Error('platform and url are required');

  const normalPlatform = platform.toLowerCase();
  if (!VALID_PLATFORMS.includes(normalPlatform)) {
    throw new Error(`Unsupported platform: "${platform}"`);
  }

  const normalQuality = (quality || 'medium').toLowerCase();
  if (!VALID_QUALITIES.includes(normalQuality)) {
    throw new Error(`Invalid quality "${quality}". Valid: ${VALID_QUALITIES.join(', ')}`);
  }

  // If a full URL was supplied, extract the channel/video identifier from it
  // so the DB stores a clean, human-readable username rather than a raw URL.
  const extractedUsername = extractUsernameFromUrl(rawInput, normalPlatform);
  const safeUser = sanitizeUsername(extractedUsername);

  // Preserve the original URL (if one was given) for storage alongside the username.
  const originalUrl = rawInput.startsWith('http') ? rawInput : null;

  const secs = Math.min(
    MAX_CLIP_SECONDS,
    Math.max(5, Number(duration) || DEFAULT_CLIP_SECS)
  );

  if (_activeJobs >= MAX_CONCURRENT_JOBS) {
    throw Object.assign(
      new Error(`Server busy — max ${MAX_CONCURRENT_JOBS} concurrent jobs`),
      { status: 503 }
    );
  }

  const job = createJob(normalPlatform, safeUser, secs);
  _activeJobs++;

  // Fire-and-forget — caller polls /clip/:id for status
  (async () => {
    try {
      const downloadUrl = `/clips/clip_${job.id}.mp4`;
      updateJob(job.id, { status: 'resolving', progress: 1, downloadUrl });

      // Record the exact moment the user pressed Capture (job.createdAt) and
      // measure how long URL resolution takes.  This offset is passed to
      // captureClip so it can seek into the stream's DVR buffer and return
      // content that started at the click moment rather than after resolution.
      const resolveStart = Date.now();
      // Use the original URL (or plain username) for stream resolution so that
      // watch?v= URLs reach yt-dlp intact.  safeUser is only for DB storage.
      const stream = await resolveStreamUrl(normalPlatform, rawInput);
      const resolutionSecs = Math.round((Date.now() - resolveStart) / 1000);

      // startOffset controls how far into the DVR buffer ffmpeg seeks.
      // resolutionSecs compensates for URL-resolution delay so the clip starts
      // at click time.  rewindOffset shifts the window further back so users
      // can capture moments that already passed — clamped at 0 so we never
      // seek before the buffer's oldest segment.
      const startOffset = Math.max(0, resolutionSecs - rewindOffset);

      updateJob(job.id, { status: 'capturing', progress: 2, startOffset });
      const outFile = await captureClip(job.id, stream, secs, normalQuality, startOffset);

      updateJob(job.id, { status: 'ready', progress: 100, outputFile: outFile });
      // Persist user + platform stats for completed clips (include original URL)
      recordClipCompletion(safeUser, normalPlatform, secs, originalUrl);
      console.log(`[Clipper] Job ${job.id} ready → ${outFile}${rewindOffset > 0 ? ` (rewound ${rewindOffset}s)` : ''}`);
    } catch (err) {
      console.error(`[Clipper] Job ${job.id} failed:`, err.message);
      updateJob(job.id, { status: 'error', error: err.message });
    } finally {
      _activeJobs--;
    }
  })();

  return jobs.get(job.id);
}

/* ============================================================
   EXPRESS ROUTER
   ============================================================ */
const router = express.Router();

// Note: rate limiting is applied per-route below (clip creation vs. polling)
// so that status-poll requests (every 2 s) never trigger a 429.

/**
 * POST /api/clipper/clip
 * Body: { platform, url, duration?, quality? }
 *   `url`      — full stream URL (e.g. https://www.youtube.com/watch?v=…)
 *                The channel/video username is extracted automatically and saved.
 *   `username` — legacy alias for `url`; still accepted for backward compatibility.
 * Returns: { jobId, status, message }
 */
router.post('/clip', clipCreationLimiter, apiKeyMiddleware, (req, res) => {
  try {
    const { platform, url, username, duration, quality, rewindOffset } = req.body || {};

    // Accept `url` (new) or `username` (legacy)
    const rawInput = url || username;

    if (!platform || !rawInput) {
      return res.status(400).json({ error: 'platform and url are required' });
    }

    if (!VALID_PLATFORMS.includes((platform || '').toLowerCase())) {
      return res.status(400).json({
        error: `Unsupported platform. Valid: ${VALID_PLATFORMS.join(', ')}`,
      });
    }

    // Validate rewindOffset: must be a non-negative integer, capped at 300 s
    const safeRewind = Math.min(300, Math.max(0, Number(rewindOffset) || 0));

    const job = startClip({ platform, url: rawInput, duration, quality, rewindOffset: safeRewind });

    res.json({
      jobId: job.id,
      status: job.status,
      message: `Clip job started for ${job.platform}/${job.username} (${job.duration}s)`,
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clipper/clip/:jobId
 * Returns the current job state (internal paths stripped).
 */
router.get('/clip/:jobId', pollLimiter, (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

/**
 * GET /api/clipper/clip/:jobId/download
 * Streams the finished mp4 to the client and deletes it afterwards.
 */
router.get('/clip/:jobId/download', (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: `Job status: ${job.status}` });
  if (!job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(410).json({ error: 'Clip file no longer exists' });
  }

  // Sanitize every field that goes into the filename to prevent header injection
  const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
  const safeUser     = shortLabel(job.username || 'unknown');
  const safeDur      = Number(job.duration) || 0;
  const filename     = safeFilename(`clip_${safePlatform}_${safeUser}_${safeDur}s.mp4`);

  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-Type', 'video/mp4');

  const stream = fs.createReadStream(job.outputFile);
  stream.pipe(res);
  stream.on('close', () => {
    fs.unlink(job.outputFile, () => {});
    updateJob(job.id, { outputFile: null, downloadUrl: null, status: 'downloaded' });
  });
});

/**
 * POST /api/clipper/clip/:jobId/catbox
 * Server-side proxy: uploads finished mp4 to Catbox.
 */
router.post('/clip/:jobId/catbox', apiKeyMiddleware, async (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
    const safeUser     = shortLabel(job.username || 'unknown');
    const filename     = `clip_${safePlatform}_${safeUser}_${Number(job.duration) || 0}s.mp4`;
    const boundary     = 'ClipperBoundary' + Date.now().toString(16);
    const CRLF         = '\r\n';

    // Only include userhash when it is actually configured.
    // Catbox's /user/api.php returns 412 "Not signed in!" when an empty
    // userhash field is present — omitting it entirely triggers a guest upload.
    const userhashPart = CATBOX_USERHASH
      ? [
          Buffer.from(`--${boundary}${CRLF}`),
          Buffer.from(`Content-Disposition: form-data; name="userhash"${CRLF}`),
          Buffer.from(CRLF),
          Buffer.from(`${CATBOX_USERHASH}${CRLF}`),
        ]
      : [];

    if (!CATBOX_USERHASH) {
      console.warn('[Catbox] CATBOX_USERHASH is not set — uploading as anonymous guest');
    }

    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="reqtype"${CRLF}`),
      Buffer.from(CRLF),
      Buffer.from(`fileupload${CRLF}`),
      ...userhashPart,
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="fileToUpload"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: video/mp4${CRLF}`),
      Buffer.from(CRLF),
      fileBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    console.log(`[Catbox] Uploading ${filename} — ${(body.length / 1048576).toFixed(1)} MB`);

    // Use an AbortController so we time out cleanly rather than hanging forever
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000); // 2-minute timeout

    let catboxRes;
    try {
      catboxRes = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
          'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
          'Accept':         'text/plain, */*',
        },
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawText = await catboxRes.text();
    const text    = rawText.trim();
    console.log(`[Catbox] Response ${catboxRes.status}: ${text.slice(0, 200)}`);

    if (!catboxRes.ok) {
      // Strip HTML tags so the error message sent to the client stays concise
      const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      return res.status(502).json({ error: `Catbox HTTP ${catboxRes.status}: ${plain}` });
    }
    if (!text.startsWith('https://')) {
      const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      return res.status(502).json({ error: `Unexpected Catbox response: ${plain}` });
    }

    res.json({ url: text });
  } catch (err) {
    console.error('[Catbox] Upload error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * POST /api/clipper/clip/:jobId/quax
 * Server-side proxy: uploads finished mp4 to qu.ax.
 */
router.post('/clip/:jobId/quax', apiKeyMiddleware, async (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
    const safeUser     = shortLabel(job.username || 'unknown');
    const filename     = `clip_${safePlatform}_${safeUser}_${Number(job.duration) || 0}s.mp4`;
    const boundary     = 'QuaxBoundary' + Date.now().toString(16);
    const CRLF         = '\r\n';

    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="files[]"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: video/mp4${CRLF}`),
      Buffer.from(CRLF),
      fileBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    console.log(`[qu.ax] Uploading ${filename} — ${(body.length / 1048576).toFixed(1)} MB`);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);

    let quaxRes;
    try {
      quaxRes = await fetch('https://qu.ax/upload.php', {
        method: 'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
          'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
        },
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawText = await quaxRes.text();
    const text    = rawText.trim();
    console.log(`[qu.ax] Response ${quaxRes.status}: ${text.slice(0, 200)}`);

    if (!quaxRes.ok) {
      const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      return res.status(502).json({ error: `qu.ax HTTP ${quaxRes.status}: ${plain}` });
    }

    let url;
    try {
      const json = JSON.parse(text);
      url = json?.files?.[0]?.url || json?.url;
    } catch (_) {
      url = text.startsWith('https://') ? text : null;
    }

    if (!url) {
      const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      return res.status(502).json({ error: `Unexpected qu.ax response: ${plain}` });
    }

    res.json({ url });
  } catch (err) {
    console.error('[qu.ax] Upload error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * POST /api/clipper/clip/:jobId/videy
 * Server-side proxy: uploads finished mp4 to videy.co.
 */
router.post('/clip/:jobId/videy', apiKeyMiddleware, async (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  if (!VIDEY_API_KEY || !VIDEY_API_SECRET) {
    return res.status(500).json({ error: 'Videy credentials not configured (set VIDEY_API_KEY and VIDEY_API_SECRET in .env)' });
  }

  try {
    const fileBuffer  = fs.readFileSync(filePath);
    const safePlatform = (job.platform || 'unknown').replace(/[^\w]/g, '_');
    const safeUser     = shortLabel(job.username || 'unknown');
    const filename     = `clip_${safePlatform}_${safeUser}_${Number(job.duration) || 0}s.mp4`;
    const boundary     = 'VideyBoundary' + Date.now().toString(16);
    const CRLF         = '\r\n';

    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: video/mp4${CRLF}`),
      Buffer.from(CRLF),
      fileBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    console.log(`[Videy] Uploading ${filename} — ${(body.length / 1048576).toFixed(1)} MB`);

    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180_000); // 3-minute timeout

    let videyRes;
    try {
      videyRes = await fetch('https://videy.co/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
          'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          'x-api-key':      VIDEY_API_KEY,
          'x-api-secret':   VIDEY_API_SECRET,
        },
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawText = await videyRes.text();
    const text    = rawText.trim();
    console.log(`[Videy] Response ${videyRes.status}: ${text.slice(0, 200)}`);

    if (!videyRes.ok) {
      const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      return res.status(502).json({ error: `Videy HTTP ${videyRes.status}: ${plain}` });
    }

    // Videy returns JSON: { id: "abc123", ... }
    let url;
    try {
      const json = JSON.parse(text);
      if (json.id) url = `https://videy.co/v/${json.id}`;
    } catch (_) {
      url = text.startsWith('https://') ? text : null;
    }

    if (!url) {
      const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      return res.status(502).json({ error: `Unexpected Videy response: ${plain}` });
    }

    res.json({ url });
  } catch (err) {
    console.error('[Videy] Upload error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * DELETE /api/clipper/clip/:jobId
 * Cancel / discard a job and its output file.
 */
router.delete('/clip/:jobId', apiKeyMiddleware, (req, res) => {
  try { assertValidJobId(req.params.jobId); } catch (e) { return res.status(400).json({ error: e.message }); }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.outputFile) fs.unlink(job.outputFile, () => {});
  jobs.delete(req.params.jobId);

  res.json({ ok: true, message: `Job ${req.params.jobId} deleted` });
});

/**
 * GET /api/clipper/users
 * List all users that have been clipped, optionally filtered by platform.
 * Query params:
 *   ?platform=youtube|twitch|kick  — filter to one platform
 *
 * Response shape:
 * {
 *   users: [
 *     { id, username, platform, url, clip_count, total_duration,
 *       first_clipped_at, last_clipped_at }
 *   ],
 *   total: <number>
 * }
 */
router.get('/users', (req, res) => {
  const { platform } = req.query;
  let rows;
  if (platform) {
    if (!VALID_PLATFORMS.includes(platform.toLowerCase())) {
      return res.status(400).json({ error: `Invalid platform. Valid: ${VALID_PLATFORMS.join(', ')}` });
    }
    rows = stmtUsersByPlat.all(platform.toLowerCase());
  } else {
    rows = stmtAllUsers.all();
  }
  res.json({ users: rows, total: rows.length });
});

/**
 * DELETE /api/clipper/users
 * Wipe all rows from the clipped_users table and reset platform stats.
 * Requires API key auth.
 * Query params:
 *   ?platform=youtube|twitch|kick  — delete only one platform's data
 */
router.delete('/users', apiKeyMiddleware, (req, res) => {
  const { platform } = req.query;
  if (platform) {
    if (!VALID_PLATFORMS.includes(platform.toLowerCase())) {
      return res.status(400).json({ error: `Invalid platform. Valid: ${VALID_PLATFORMS.join(', ')}` });
    }
    const plat = platform.toLowerCase();
    db.prepare('DELETE FROM clipped_users WHERE platform = ?').run(plat);
    db.prepare('DELETE FROM platform_stats WHERE platform = ?').run(plat);
    return res.json({ ok: true, message: `Deleted all user data for platform: ${plat}` });
  }

  db.prepare('DELETE FROM clipped_users').run();
  db.prepare('DELETE FROM platform_stats').run();
  res.json({ ok: true, message: 'All user data deleted' });
});

/**
 * GET /api/clipper/stats
 * Aggregated clip statistics per platform.
 *
 * Response shape:
 * {
 *   platforms: [
 *     { platform, clip_count, total_duration, unique_users, last_activity_at }
 *   ]
 * }
 */
router.get('/stats', (req, res) => {
  const platforms = stmtAllPlatStats.all();
  res.json({ platforms });
});

/**
 * GET /api/clipper/jobs
 * List all jobs (most recent first, max 100) — internal paths stripped.
 */
router.get('/jobs', (req, res) => {
  const list = jobs.values().map(publicJob);
  res.json({ jobs: list, total: jobs.size });
});

/**
 * GET /api/clipper/platforms
 * Describe supported platforms and expected username format.
 */
router.get('/platforms', (_req, res) => {
  res.json({
    platforms: [
      { id: 'youtube', label: 'YouTube', urlExample: 'https://www.youtube.com/@mkbhd/live  OR  https://www.youtube.com/watch?v=VIDEO_ID', method: 'yt-dlp → HLS' },
      { id: 'twitch',  label: 'Twitch',  urlExample: 'https://www.twitch.tv/xqc',                                                        method: 'yt-dlp → HLS' },
      { id: 'kick',    label: 'Kick',    urlExample: 'https://kick.com/xqc',                                                              method: 'Kick API → HLS / yt-dlp fallback' },
    ],
  });
});

/**
 * GET /api/clipper/config
/**
 * GET /api/clipper/config
 * Returns config info for the frontend and auto-issues a fresh session token.
 * The session token (not the raw API key) is used by the browser for all
 * subsequent mutating requests, so the real CLIPPER_API_KEY never leaves the server.
 */
router.get('/config', apiKeyMiddleware, (req, res) => {
  const sessionToken = createSession();
  res.json({
    sessionToken,
    maxClipSeconds:    MAX_CLIP_SECONDS,
    defaultClipSecs:   DEFAULT_CLIP_SECS,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    platforms:         VALID_PLATFORMS,
    qualities:         VALID_QUALITIES,
  });
});

/**
 * POST /api/clipper/login
 * Open endpoint — issues a session token + config values the browser needs.
 * The browser calls this on page load instead of /config so the real
 * CLIPPER_API_KEY is never required on the client side.
 */
router.post('/login', (_req, res) => {
  res.json({
    sessionToken:      createSession(),
    maxClipSeconds:    MAX_CLIP_SECONDS,
    defaultClipSecs:   DEFAULT_CLIP_SECS,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    platforms:         VALID_PLATFORMS,
    qualities:         VALID_QUALITIES,
  });
});

/**
 * POST /api/clipper/logout
 * Body: (none — reads token from Authorization: Session <token>)
 * Invalidates the session immediately.
 */
router.post('/logout', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Session ') ? header.slice(8).trim() : '';
  if (token) _sessions.delete(token);
  res.json({ ok: true });
});

/* ============================================================
   STANDALONE MODE
   ============================================================ */
if (require.main === module) {
  const app  = express();
  const PORT = process.env.PORT || 4242;

  app.use(express.json());
  app.use('/api/clipper', router);

  // Serve finished clips at /clips/<filename>
  app.use('/clips', express.static(CLIP_OUTPUT_DIR));

  // Serve the frontend (clipper.html, clipper.css) from public/
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  app.use(express.static(publicDir, { index: 'clipper.html' }));

  // Explicit root: always send clipper.html
  app.get('/', (_req, res) => {
    const page = path.join(publicDir, 'clipper.html');
    fs.existsSync(page)
      ? res.sendFile(page)
      : res.status(404).send('Place clipper.html + clipper.css in the public/ folder.');
  });
  app.listen(PORT, () => {
    console.log(`[Clipper] Standalone server on http://localhost:${PORT}`);
    console.log(`[Clipper] POST http://localhost:${PORT}/api/clipper/clip`);
    console.log(`[Clipper] Clips saved to: ${CLIP_OUTPUT_DIR}`);
  });
}

module.exports = { router, startClip, resolveStreamUrl };