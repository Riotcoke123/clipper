/**
 * clipper.js — Multi-platform live stream clipper
 *
 * Supported platforms: YouTube · Twitch · Kick · Odysee
 *
 * Mount as an Express router:
 *   const clipper = require('./clipper');
 *   app.use('/api/clipper', clipper.router);
 *
 * Or run standalone:
 *   node clipper.js
 *
 * Environment variables (all optional — sensible defaults):
 *   CLIP_OUTPUT_DIR   — where finished .mp4 clips are stored   (default: ./public/clips)
 *   CLIP_TEMP_DIR     — scratch space during capture             (default: ./temp)
 *   KICK_API_BASE     — Kick public API root                     (default: https://api.kick.com)
 *   ODYSEE_LIVE_API   — Odysee live API root                     (default: https://api.odysee.live)
 *   ODYSEE_SDK_PROXY  — Odysee SDK proxy root                    (default: https://api.na-backend.odysee.com)
 *   ODYSEE_COOKIE     — auth cookie for Odysee (optional)
 *   MAX_CLIP_SECONDS  — hard cap on requested duration           (default: 300)
 *   DEFAULT_CLIP_SECS — fallback duration when none provided     (default: 60)
 *   DB_PATH           — path to the SQLite database file         (default: ./clipper.db)
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const { spawn } = require('child_process');
const ffmpeg   = require('fluent-ffmpeg');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const Database = require('better-sqlite3');

/* ============================================================
   CONFIG
   ============================================================ */
const CLIP_OUTPUT_DIR  = process.env.CLIP_OUTPUT_DIR  || path.join(__dirname, 'public', 'clips');
const CLIP_TEMP_DIR    = process.env.CLIP_TEMP_DIR    || path.join(__dirname, 'temp');
const KICK_API_BASE    = process.env.KICK_API_BASE    || 'https://api.kick.com';
const ODYSEE_LIVE_API  = process.env.ODYSEE_LIVE_API  || 'https://api.odysee.live';
const ODYSEE_SDK_PROXY = process.env.ODYSEE_SDK_PROXY || 'https://api.na-backend.odysee.com';
const ODYSEE_COOKIE    = process.env.ODYSEE_COOKIE    || '';
const CATBOX_USERHASH        = process.env.CATBOX_USERHASH        || '';
const BUZZHEAVIER_ACCOUNT_ID = process.env.BUZZHEAVIER_ACCOUNT_ID || '';
const BUZZHEAVIER_PARENT_ID  = process.env.BUZZHEAVIER_PARENT_ID  || BUZZHEAVIER_ACCOUNT_ID;
const MAX_CLIP_SECONDS  = Number(process.env.MAX_CLIP_SECONDS)  || 300;
const DEFAULT_CLIP_SECS = Number(process.env.DEFAULT_CLIP_SECS) || 60;
const DB_PATH           = process.env.DB_PATH || path.join(__dirname, 'clipper.db');

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
    createdAt   TEXT NOT NULL
  )
`);

// Prepared statements
const stmtInsert = db.prepare(`
  INSERT INTO jobs (id, platform, username, duration, status, progress, outputFile, downloadUrl, error, createdAt)
  VALUES (@id, @platform, @username, @duration, @status, @progress, @outputFile, @downloadUrl, @error, @createdAt)
`);

const stmtSelectOne = db.prepare('SELECT * FROM jobs WHERE id = ?');

const stmtUpdate = db.prepare(`
  UPDATE jobs
  SET status      = COALESCE(@status,      status),
      progress    = COALESCE(@progress,    progress),
      outputFile  = COALESCE(@outputFile,  outputFile),
      downloadUrl = COALESCE(@downloadUrl, downloadUrl),
      error       = COALESCE(@error,       error)
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
  });
}

/* ============================================================
   PLATFORM: STREAM-URL RESOLVERS
   ============================================================ */

/**
 * YouTube — ask yt-dlp for the direct HLS manifest of a live stream.
 * Input:  channel URL or video URL (watch?v=…, /live/…, @handle)
 */
async function resolveYouTube(username) {
  // Normalise: bare handle → full URL
  // Return the page URL directly — yt-dlp resolves format + auth in one shot
  // during captureClip, avoiding signed-URL expiry from a two-step --get-url call.
  const url = username.startsWith('http')
    ? username
    : `https://www.youtube.com/@${username}/live`;
  return { type: 'ytdlp', url };
}

/**
 * Twitch — yt-dlp handles OAuth-less public stream extraction perfectly.
 */
async function resolveTwitch(username) {
  return { type: 'ytdlp', url: `https://www.twitch.tv/${username}` };
}

/**
 * Kick — use public v1 API to get the HLS playlist URL.
 * Falls back to yt-dlp if the API doesn't surface a playback URL.
 */
async function resolveKick(username) {
  try {
    const res = await fetch(
      `${KICK_API_BASE}/public/v1/channels?broadcaster_username=${encodeURIComponent(username)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`Kick API ${res.status}`);
    const json = await res.json();
    const channel = json?.data?.[0];

    if (!channel?.livestream?.is_live) throw new Error('Channel is not live');

    // Prefer the HLS playback URL surfaced by the API
    const playbackUrl = channel?.playback_url
      || channel?.livestream?.playback_url
      || channel?.livestream?.session?.playback_url;

    if (playbackUrl) return { type: 'hls', url: playbackUrl };

    // Fallback: old public v2 channel endpoint
    const res2 = await fetch(
      `https://kick.com/api/v2/channels/${encodeURIComponent(username)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (res2.ok) {
      const j2 = await res2.json();
      const m3u8 = j2?.livestream?.session?.playback_url
        || j2?.playback_url;
      if (m3u8) return { type: 'hls', url: m3u8 };
    }
  } catch (err) {
    console.warn(`[Kick] API failed (${err.message}), falling back to yt-dlp`);
  }

  // Last resort: let yt-dlp resolve format + auth in one shot during captureClip
  return { type: 'ytdlp', url: `https://kick.com/${username}` };
}

/**
 * Odysee — query the Odysee live API, then the SDK proxy,
 * to find the HLS manifest of a live channel.
 */
async function resolveOdysee(username) {
  // Username can arrive as "@Channel:claimId", "@Channel", or a full URL
  let channelName = username;
  if (username.startsWith('http')) {
    // e.g. https://odysee.com/@Channel:abc — extract the handle
    channelName = new URL(username).pathname.replace(/^\//, '');
  }
  // Strip leading @ if present
  const handle = channelName.startsWith('@') ? channelName : `@${channelName}`;

  // 1. Try the Odysee live API
  try {
    const liveRes = await fetch(
      `${ODYSEE_LIVE_API}/api/v2?m=livestream.is_live`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(ODYSEE_COOKIE ? { Cookie: ODYSEE_COOKIE } : {}) },
        body: JSON.stringify({ channel_name: handle }),
      }
    );
    if (liveRes.ok) {
      const liveJson = await liveRes.json();
      const m3u8 = liveJson?.data?.VideoURL || liveJson?.data?.url;
      if (m3u8) return { type: 'hls', url: m3u8 };
    }
  } catch (_) {}

  // 2. Try the SDK proxy (resolve → lbry:// → check live endpoint)
  try {
    const resolveRes = await fetch(`${ODYSEE_SDK_PROXY}/api/v1/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'resolve',
        params: { urls: [handle], include_is_my_output: false },
      }),
    });
    if (resolveRes.ok) {
      const rj = await resolveRes.json();
      const claimId = rj?.result?.[handle]?.claim_id;
      if (claimId) {
        const liveUrl = `${ODYSEE_LIVE_API}/api/v2?m=livestream.get_active&channel_claim_id=${claimId}`;
        const lr = await fetch(liveUrl, {
          headers: ODYSEE_COOKIE ? { Cookie: ODYSEE_COOKIE } : {},
        });
        if (lr.ok) {
          const lj = await lr.json();
          const m3u8 = lj?.data?.VideoURL || lj?.data?.url;
          if (m3u8) return { type: 'hls', url: m3u8 };
        }
      }
    }
  } catch (_) {}

  // 3. Fallback: let yt-dlp resolve format + auth in one shot during captureClip
  const pageUrl = username.startsWith('http')
    ? username
    : `https://odysee.com/@${username.replace(/^@/, '')}`;
  return { type: 'ytdlp', url: pageUrl };
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
      '--no-check-certificate',
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
    case 'odysee':  return resolveOdysee(username);
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
 * @param {{ type: 'hls'|'flv', url: string }} stream
 * @param {number} duration  seconds
 * @param {'low'|'medium'|'high'} quality
 * @returns {Promise<string>} absolute path to the finished mp4
 */
async function captureClip(jobId, stream, duration, quality = 'medium') {
  const outFile = path.join(CLIP_OUTPUT_DIR, `clip_${jobId}.mp4`);
  const tempRaw = path.join(CLIP_TEMP_DIR, `raw_${jobId}`);

  if (stream.type === 'flv') {
    // --- FLV path: ffmpeg straight from CDN ---
    return new Promise((resolve, reject) => {
      updateJob(jobId, { status: 'capturing', progress: 5 });

      const sizeFilter = quality === 'low'  ? '640:-2'
                       : quality === 'high' ? '1280:-2'
                       : '854:-2';

      ffmpeg(stream.url)
        .inputOptions(['-t', String(duration)])
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('128k')
        .videoFilter(`scale=${sizeFilter}`)
        .outputOptions([
          '-preset veryfast',
          '-movflags +faststart',
          '-avoid_negative_ts make_zero',
        ])
        .output(outFile)
        .on('progress', prog => {
          const pct = Math.min(95, prog.percent || 0);
          updateJob(jobId, { status: 'encoding', progress: pct });
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
  // 'ytdlp' type passes the original page URL so yt-dlp handles auth + format
  // resolution in a single invocation (avoids signed-URL expiry from --get-url).
  // 'hls' type passes a direct manifest URL obtained from a platform API.
  const formatArg = quality === 'low'
    ? 'worst[protocol^=m3u8][height>=360]/worst[protocol^=m3u8]/worst[height>=360]/worst'
    : quality === 'high'
    ? 'best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best[height<=1080]/best'
    : 'best[protocol^=m3u8][height<=720]/best[protocol^=m3u8]/best[height<=720]/best';

  const tempFile = `${tempRaw}.mp4`;

  await new Promise((resolve, reject) => {
    updateJob(jobId, { status: 'capturing', progress: 2 });

    // Kick's extractor requires browser impersonation to bypass bot detection.
    // Needs curl_cffi: pip install curl_cffi  (or: pip install yt-dlp[default])
    const needsImpersonation = /kick\.com/i.test(stream.url);

    const args = [
      '--no-playlist',
      '--no-check-certificate',
      '--format', formatArg,
      '--downloader', 'ffmpeg',
      '--downloader-args', `ffmpeg:-t ${duration}`,
      ...(needsImpersonation ? ['--impersonate', 'chrome'] : []),
      '-o', tempFile,
      stream.url,
    ];

    const proc = spawn('yt-dlp', args);
    let stderr = '';

    proc.stdout.on('data', data => {
      const out = data.toString();
      const m = out.match(/(\d+\.?\d*)%/);
      if (m) {
        // Map download progress to 2–70%
        const pct = 2 + Math.min(68, parseFloat(m[1]) * 0.68);
        updateJob(jobId, { progress: Math.round(pct) });
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

    ffmpeg(tempFile)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .videoFilter(`scale=${sizeFilter}`)
      .outputOptions([
        '-preset veryfast',
        '-movflags +faststart',
      ])
      .output(outFile)
      .on('progress', prog => {
        const pct = 72 + Math.min(23, (prog.percent || 0) * 0.23);
        updateJob(jobId, { progress: Math.round(pct) });
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
 * @param {string} opts.platform   'youtube'|'twitch'|'kick'|'odysee'
 * @param {string} opts.username   channel handle / URL
 * @param {number} [opts.duration] seconds to capture (capped at MAX_CLIP_SECONDS)
 * @param {'low'|'medium'|'high'} [opts.quality]
 * @returns {ClipJob}
 */
function startClip({ platform, username, duration, quality = 'medium' }) {
  if (!platform || !username) throw new Error('platform and username are required');

  const secs = Math.min(
    MAX_CLIP_SECONDS,
    Math.max(5, Number(duration) || DEFAULT_CLIP_SECS)
  );

  const job = createJob(platform.toLowerCase(), username, secs);

  // Fire-and-forget — caller polls /clip/:id for status
  (async () => {
    try {
      // Pre-write the downloadUrl so it's always present when status flips to 'ready'.
      // Without this, the 1.2 s poller can see status=ready with downloadUrl=null,
      // fall back to the /download endpoint, and have the clip deleted before the
      // user can watch the preview.
      const downloadUrl = `/clips/clip_${job.id}.mp4`;
      updateJob(job.id, { status: 'resolving', progress: 1, downloadUrl });

      const stream = await resolveStreamUrl(platform, username);

      updateJob(job.id, { status: 'capturing', progress: 2 });
      const outFile = await captureClip(job.id, stream, secs, quality);

      updateJob(job.id, { status: 'ready', progress: 100, outputFile: outFile });
      console.log(`[Clipper] Job ${job.id} ready → ${outFile}`);
    } catch (err) {
      console.error(`[Clipper] Job ${job.id} failed:`, err.message);
      updateJob(job.id, { status: 'error', error: err.message });
    }
  })();

  return jobs.get(job.id);
}

/* ============================================================
   EXPRESS ROUTER
   ============================================================ */
const router = express.Router();

/**
 * POST /api/clipper/clip
 * Body: { platform, username, duration?, quality? }
 * Returns: { jobId, status, message }
 */
router.post('/clip', (req, res) => {
  try {
    const { platform, username, duration, quality } = req.body || {};

    if (!platform || !username) {
      return res.status(400).json({ error: 'platform and username are required' });
    }

    const VALID_PLATFORMS = ['youtube', 'twitch', 'kick', 'odysee'];
    if (!VALID_PLATFORMS.includes(platform.toLowerCase())) {
      return res.status(400).json({
        error: `Unsupported platform. Valid: ${VALID_PLATFORMS.join(', ')}`,
      });
    }

    const job = startClip({ platform, username, duration, quality });

    res.json({
      jobId: job.id,
      status: job.status,
      message: `Clip job started for ${platform}/${username} (${job.duration}s)`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/clipper/clip/:jobId
 * Returns the current job state.
 */
router.get('/clip/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * GET /api/clipper/clip/:jobId/download
 * Streams the finished mp4 to the client and deletes it afterwards.
 */
router.get('/clip/:jobId/download', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: `Job status: ${job.status}` });
  if (!job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(410).json({ error: 'Clip file no longer exists' });
  }

  const filename = `clip_${job.platform}_${job.username}_${job.duration}s.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');

  const stream = fs.createReadStream(job.outputFile);
  stream.pipe(res);
  stream.on('close', () => {
    // Remove clip file after download to save disk space
    fs.unlink(job.outputFile, () => {});
    updateJob(job.id, { outputFile: null, downloadUrl: null, status: 'downloaded' });
  });
});

/**
 * POST /api/clipper/clip/:jobId/catbox
 * Server-side proxy: reads the finished mp4 and uploads it to Catbox anonymously.
 * Returns: { url } on success.
 *
 * We do this server-side because Catbox does not send CORS headers, so a
 * direct browser fetch to catbox.moe/user/api.php is blocked.
 */
router.post('/clip/:jobId/catbox', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const filename   = `clip_${job.platform}_${job.username}_${job.duration}s.mp4`;
    const boundary   = 'ClipperBoundary' + Date.now().toString(16);
    const CRLF       = '\r\n';

    // Manually build a valid multipart/form-data body as a single Buffer.
    // node-fetch receives a Buffer and sets the body correctly without
    // needing FormData or Blob — works on Node 16, 18, 20+.
    const body = Buffer.concat([
      // ── field: reqtype ──
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="reqtype"${CRLF}`),
      Buffer.from(CRLF),
      Buffer.from(`fileupload${CRLF}`),
      // ── field: userhash (empty = anonymous upload) ──
      // Catbox requires this field to be present even for anonymous uploads;
      // omitting it entirely returns 412 "Invalid uploader".
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="userhash"${CRLF}`),
      Buffer.from(CRLF),
      Buffer.from(`${CATBOX_USERHASH}${CRLF}`),
      // ── field: fileToUpload ──
      Buffer.from(`--${boundary}${CRLF}`),
      Buffer.from(`Content-Disposition: form-data; name="fileToUpload"; filename="${filename}"${CRLF}`),
      Buffer.from(`Content-Type: video/mp4${CRLF}`),
      Buffer.from(CRLF),          // blank line separates headers from body
      fileBuffer,
      Buffer.from(CRLF),
      // ── closing boundary ──
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    console.log(`[Catbox] Uploading ${filename} — ${(body.length / 1048576).toFixed(1)} MB`);

    const catboxRes = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
      },
      body,
    });

    const text = (await catboxRes.text()).trim();
    console.log(`[Catbox] Response ${catboxRes.status}: ${text}`);

    if (!catboxRes.ok) {
      return res.status(502).json({ error: `Catbox HTTP ${catboxRes.status}: ${text}` });
    }
    if (!text.startsWith('https://')) {
      return res.status(502).json({ error: `Unexpected Catbox response: ${text}` });
    }

    res.json({ url: text });
  } catch (err) {
    console.error('[Catbox] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clipper/clip/:jobId/quax
 * Server-side proxy: uploads the finished mp4 to qu.ax (no auth required).
 * qu.ax accepts multipart/form-data with a "files[]" field.
 * Returns: { url } on success.
 *
 * Done server-side because qu.ax does not send CORS headers, so a direct
 * browser fetch is blocked.
 */
router.post('/clip/:jobId/quax', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const filename   = `clip_${job.platform}_${job.username}_${job.duration}s.mp4`;
    const boundary   = 'QuaxBoundary' + Date.now().toString(16);
    const CRLF       = '\r\n';

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

    const quaxRes = await fetch('https://qu.ax/upload.php', {
      method: 'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
      },
      body,
    });

    const text = (await quaxRes.text()).trim();
    console.log(`[qu.ax] Response ${quaxRes.status}: ${text.slice(0, 200)}`);

    if (!quaxRes.ok) {
      return res.status(502).json({ error: `qu.ax HTTP ${quaxRes.status}: ${text}` });
    }

    // qu.ax returns JSON: { files: [{ url, name, size }] }
    let url;
    try {
      const json = JSON.parse(text);
      url = json?.files?.[0]?.url || json?.url;
    } catch (_) {
      // Fall back to plain-text URL (some qu.ax responses are bare URLs)
      url = text.startsWith('https://') ? text : null;
    }

    if (!url) {
      return res.status(502).json({ error: `Unexpected qu.ax response: ${text}` });
    }

    res.json({ url });
  } catch (err) {
    console.error('[qu.ax] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clipper/clip/:jobId/buzzheavier
 * Server-side proxy: uploads the finished mp4 to BuzzHeavier via HTTP PUT.
 * Uses BUZZHEAVIER_ACCOUNT_ID as the Bearer token and BUZZHEAVIER_PARENT_ID
 * as the parent-folder segment in the URL.
 * Returns: { url } on success.
 *
 * BuzzHeavier endpoint: PUT https://w.buzzheavier.com/{parentId}/{filename}
 * Authorization: Bearer {accountId}
 */
router.post('/clip/:jobId/buzzheavier', async (req, res) => {
  if (!BUZZHEAVIER_ACCOUNT_ID) {
    return res.status(503).json({ error: 'BUZZHEAVIER_ACCOUNT_ID is not configured' });
  }

  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const filePath = job.outputFile;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'Clip file not found on disk' });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const filename   = `clip_${job.platform}_${job.username}_${job.duration}s.mp4`;
    const uploadUrl  = `https://w.buzzheavier.com/${BUZZHEAVIER_PARENT_ID}/${encodeURIComponent(filename)}`;

    console.log(`[BuzzHeavier] Uploading ${filename} — ${(fileBuffer.length / 1048576).toFixed(1)} MB → ${uploadUrl}`);

    const bhRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization':  `Bearer ${BUZZHEAVIER_ACCOUNT_ID}`,
        'Content-Type':   'video/mp4',
        'Content-Length': String(fileBuffer.length),
        'User-Agent':     process.env.USER_AGENT || 'Mozilla/5.0',
      },
      body: fileBuffer,
    });

    const text = (await bhRes.text()).trim();
    console.log(`[BuzzHeavier] Response ${bhRes.status}: ${text.slice(0, 200)}`);

    if (!bhRes.ok) {
      return res.status(502).json({ error: `BuzzHeavier HTTP ${bhRes.status}: ${text}` });
    }

    // BuzzHeavier returns JSON with the file's public URL or id
    let url;
    try {
      const json = JSON.parse(text);
      // Try common response shapes
      url = json?.data?.downloadPage
        || json?.data?.url
        || json?.url
        || (json?.id ? `https://buzzheavier.com/${json.id}` : null);
    } catch (_) {
      url = text.startsWith('https://') ? text : null;
    }

    if (!url) {
      return res.status(502).json({ error: `Unexpected BuzzHeavier response: ${text}` });
    }

    res.json({ url });
  } catch (err) {
    console.error('[BuzzHeavier] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/clipper/clip/:jobId
 * Cancel / discard a job and its output file.
 */
router.delete('/clip/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.outputFile) fs.unlink(job.outputFile, () => {});
  jobs.delete(req.params.jobId);

  res.json({ ok: true, message: `Job ${req.params.jobId} deleted` });
});

/**
 * GET /api/clipper/jobs
 * List all jobs (most recent first, max 100).
 */
router.get('/jobs', (_req, res) => {
  const list = jobs.values();
  res.json({ jobs: list, total: jobs.size });
});

/**
 * GET /api/clipper/platforms
 * Describe supported platforms and expected username format.
 */
router.get('/platforms', (_req, res) => {
  res.json({
    platforms: [
      { id: 'youtube', label: 'YouTube',    usernameExample: 'mkbhd  OR  https://youtube.com/@mkbhd/live',  method: 'yt-dlp → HLS' },
      { id: 'twitch',  label: 'Twitch',     usernameExample: 'xqc',                                          method: 'yt-dlp → HLS' },
      { id: 'kick',    label: 'Kick',        usernameExample: 'xqc',                                          method: 'Kick API → HLS / yt-dlp fallback' },
      { id: 'odysee',  label: 'Odysee',     usernameExample: '@DistroWatch  OR  https://odysee.com/@Channel', method: 'Odysee live API → HLS / yt-dlp fallback' },
    ],
  });
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