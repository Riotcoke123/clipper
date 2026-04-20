require('dotenv').config();

/* ==========================================================================
   IMPORTS
   ========================================================================== */
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const { spawn }  = require('child_process');
const ffmpeg     = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const axios      = require('axios');
const FormData   = require('form-data');

/* ==========================================================================
   CONFIG
   ========================================================================== */
const app  = express();
const PORT = process.env.PORT || 5000;

// Max seconds a user can capture in one request
const MAX_CAPTURE_DURATION = Number(process.env.MAX_CAPTURE_DURATION || 240);

// How long (ms) to keep completed/errored jobs in memory before cleanup
const JOB_TTL_MS = Number(process.env.JOB_TTL_SECONDS || 3600) * 1000;

// pomf.lain.la upload endpoint
const POMF_UPLOAD_URL = process.env.POMF_UPLOAD_URL || 'https://pomf.lain.la/upload.php';

/* ==========================================================================
   DIRECTORIES
   ========================================================================== */
const tempDir  = path.join(__dirname, 'temp');
const clipsDir = path.join(__dirname, 'public', 'clips');

for (const dir of [tempDir, clipsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ==========================================================================
   MIDDLEWARE
   ========================================================================== */
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   JOB STORE
   ========================================================================== */
/**
 * In-memory job map.
 * Shape: { status, progress, outputFile, previewFile, error?, clipFile?, uploadUrl? }
 * Status flow: capturing → processing → ready → [clipping → clip_ready] → [uploading → uploaded]
 */
const activeJobs = new Map();

/** Schedules automatic removal of a finished/errored job after JOB_TTL_MS. */
function scheduleJobCleanup(captureId) {
  setTimeout(() => {
    const job = activeJobs.get(captureId);
    if (!job) return;

    // Delete files on disk then remove from map
    for (const key of ['outputFile', 'previewFile', 'clipFile']) {
      if (job[key] && fs.existsSync(job[key])) {
        fs.unlink(job[key], () => {});
      }
    }
    activeJobs.delete(captureId);
    console.log(`[cleanup] Job ${captureId} removed.`);
  }, JOB_TTL_MS);
}

/* ==========================================================================
   HELPERS
   ========================================================================== */

/**
 * Builds the yt-dlp format string from the quality setting.
 */
function ytDlpFormat(quality) {
  switch (quality) {
    case 'low':    return 'worst[height>=480]/worst';
    case 'medium': return 'best[height<=720]/best[height<=720]';
    case 'high':   return 'best[height<=1080]/best[height<=1080]';
    default:       return 'best/best';
  }
}

/**
 * Returns true when a job exists AND has reached one of the given statuses.
 */
function jobIs(captureId, ...statuses) {
  const job = activeJobs.get(captureId);
  return job && statuses.includes(job.status);
}

/* ==========================================================================
   ROUTES
   ========================================================================== */

/* ------------------------------------------------------------------
   POST /api/capture-stream
   Starts yt-dlp capture, streams to a temp file, then creates a
   compressed preview clip. Returns captureId immediately; client
   polls /api/capture-status/:captureId for progress.
   ------------------------------------------------------------------ */
app.post('/api/capture-stream', async (req, res) => {
  try {
    const { url, platform, quality, duration } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Stream URL is required.' });
    }

    const captureDuration = Math.min(
      Number(duration) || MAX_CAPTURE_DURATION,
      MAX_CAPTURE_DURATION
    );

    const captureId  = uuidv4();
    const outputFile = path.join(tempDir, `${captureId}.mp4`);
    const previewFile = path.join(clipsDir, `preview_${captureId}.mp4`);

    // Register job immediately so the status endpoint can respond right away
    activeJobs.set(captureId, {
      status:      'capturing',
      progress:    0,
      outputFile,
      previewFile,
      error:       null,
    });

    console.log(`[capture] Starting job ${captureId} — url=${url} duration=${captureDuration}s`);

    const ytArgs = [
      '-f', ytDlpFormat(quality),
      '--no-playlist',
      '--no-check-certificate',
      '--downloader', 'ffmpeg',
      '--downloader-args', `ffmpeg:-t ${captureDuration}`,
      '-o', outputFile,
      url,
    ];

    const ytDlp = spawn('yt-dlp', ytArgs);

    ytDlp.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      console.log(`[yt-dlp] ${text.trim()}`);

      const match = text.match(/(\d+\.?\d*)%/);
      if (match) {
        const job = activeJobs.get(captureId);
        if (job) { job.progress = parseFloat(match[1]); }
      }
    });

    ytDlp.stderr.on('data', (chunk) => {
      console.error(`[yt-dlp err] ${chunk.toString().trim()}`);
    });

    ytDlp.on('error', (err) => {
      console.error(`[yt-dlp spawn error] ${err.message}`);
      const job = activeJobs.get(captureId);
      if (job) { job.status = 'error'; job.error = err.message; }
      scheduleJobCleanup(captureId);
    });

    ytDlp.on('close', (code) => {
      const job = activeJobs.get(captureId);
      if (!job) return;

      if (code !== 0) {
        job.status = 'error';
        job.error  = `yt-dlp exited with code ${code}`;
        scheduleJobCleanup(captureId);
        return;
      }

      // Transcode to a web-safe preview
      console.log(`[capture] yt-dlp done, creating preview for ${captureId}`);
      job.status   = 'processing';
      job.progress = 0;

      ffmpeg(outputFile)
        .output(previewFile)
        .videoCodec('libx264')
        .size('640x?')
        .audioCodec('aac')
        .audioBitrate('128k')
        .outputOptions(['-preset veryfast', '-movflags faststart', '-crf 23'])
        .on('progress', (p) => {
          const pct = p.percent ?? 0;
          console.log(`[ffmpeg] ${captureId} — ${pct.toFixed(1)}%`);
          job.progress = pct;
        })
        .on('end', () => {
          console.log(`[capture] Preview ready for ${captureId}`);
          job.status   = 'ready';
          job.progress = 100;
          scheduleJobCleanup(captureId);
        })
        .on('error', (err) => {
          console.error(`[ffmpeg error] ${err.message}`);
          job.status = 'error';
          job.error  = err.message;
          scheduleJobCleanup(captureId);
        })
        .run();
    });

    // Respond immediately — client polls for status
    return res.json({ success: true, captureId });

  } catch (err) {
    console.error('[capture] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   GET /api/capture-status/:captureId
   Returns current job progress and, when ready, the preview URL.
   ------------------------------------------------------------------ */
app.get('/api/capture-status/:captureId', (req, res) => {
  const { captureId } = req.params;
  const job = activeJobs.get(captureId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }

  const response = {
    captureId,
    status:   job.status,
    progress: Math.round(job.progress ?? 0),
  };

  if (job.status === 'error') {
    response.error = job.error;
  }

  if (job.status === 'ready' || job.status === 'clip_ready' || job.status === 'uploaded') {
    response.previewUrl = `/clips/preview_${captureId}.mp4`;
  }

  if (job.status === 'clip_ready' || job.status === 'uploaded') {
    response.clipUrl = `/clips/clip_${job.clipId}.mp4`;
    response.clipId  = job.clipId;
  }

  if (job.status === 'uploaded') {
    response.uploadUrl = job.uploadUrl;
  }

  return res.json(response);
});

/* ------------------------------------------------------------------
   POST /api/create-clip
   Cuts a segment out of the captured preview using ffmpeg.
   Body: { captureId, startTime (seconds), duration (seconds) }
   ------------------------------------------------------------------ */
app.post('/api/create-clip', async (req, res) => {
  try {
    const { captureId, startTime, duration } = req.body;

    if (!captureId) {
      return res.status(400).json({ error: 'captureId is required.' });
    }

    const job = activeJobs.get(captureId);
    if (!job) {
      return res.status(404).json({ error: 'Capture job not found or expired.' });
    }
    if (job.status !== 'ready') {
      return res.status(409).json({
        error: `Capture is not ready yet (current status: ${job.status}).`,
      });
    }

    const clipStart    = Math.max(0, Number(startTime) || 0);
    const clipDuration = Math.min(Math.max(1, Number(duration) || 60), MAX_CAPTURE_DURATION);

    const clipId   = uuidv4();
    const clipFile = path.join(clipsDir, `clip_${clipId}.mp4`);

    job.status   = 'clipping';
    job.progress = 0;
    job.clipId   = clipId;

    console.log(`[clip] Job ${captureId} — start=${clipStart}s dur=${clipDuration}s → ${clipFile}`);

    ffmpeg(job.previewFile)
      .seekInput(clipStart)
      .duration(clipDuration)
      .output(clipFile)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset veryfast', '-movflags faststart', '-crf 23'])
      .on('progress', (p) => {
        job.progress = p.percent ?? 0;
      })
      .on('end', () => {
        job.status    = 'clip_ready';
        job.progress  = 100;
        job.clipFile  = clipFile;

        console.log(`[clip] Clip ready: ${clipFile}`);
        return res.json({
          success:     true,
          clipId,
          downloadUrl: `/clips/clip_${clipId}.mp4`,
        });
      })
      .on('error', (err) => {
        console.error(`[clip ffmpeg error] ${err.message}`);
        job.status = 'error';
        job.error  = err.message;
        return res.status(500).json({ error: 'Failed to create clip: ' + err.message });
      })
      .run();

  } catch (err) {
    console.error('[create-clip] Unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   POST /api/upload-clip
   Uploads a finished clip to pomf.lain.la and returns the public URL.
   Body: { clipId }
   ------------------------------------------------------------------ */
app.post('/api/upload-clip', async (req, res) => {
  try {
    const { clipId } = req.body;

    if (!clipId) {
      return res.status(400).json({ error: 'clipId is required.' });
    }

    // Find the job that owns this clipId
    let targetJob = null;
    for (const [, job] of activeJobs) {
      if (job.clipId === clipId) { targetJob = job; break; }
    }

    if (!targetJob) {
      return res.status(404).json({ error: 'Clip not found or expired.' });
    }
    if (targetJob.status !== 'clip_ready') {
      return res.status(409).json({
        error: `Clip is not ready for upload (status: ${targetJob.status}).`,
      });
    }
    if (!targetJob.clipFile || !fs.existsSync(targetJob.clipFile)) {
      return res.status(500).json({ error: 'Clip file missing on disk.' });
    }

    targetJob.status   = 'uploading';
    targetJob.progress = 0;

    console.log(`[upload] Uploading clip ${clipId} to pomf.lain.la`);

    const form = new FormData();
    form.append('files[]', fs.createReadStream(targetJob.clipFile), {
      filename:    `clip_${clipId}.mp4`,
      contentType: 'video/mp4',
    });

    const pomfRes = await axios.post(POMF_UPLOAD_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
      onUploadProgress: (evt) => {
        if (evt.total) {
          targetJob.progress = Math.round((evt.loaded / evt.total) * 100);
        }
      },
    });

    // pomf returns: { success, files: [{ url, name, hash, size }] }
    const pomfData = pomfRes.data;

    if (!pomfData.success || !pomfData.files?.length) {
      throw new Error('pomf.lain.la returned an unexpected response.');
    }

    const uploadUrl = pomfData.files[0].url;

    targetJob.status    = 'uploaded';
    targetJob.progress  = 100;
    targetJob.uploadUrl = uploadUrl;

    console.log(`[upload] Done — ${uploadUrl}`);
    return res.json({ success: true, url: uploadUrl });

  } catch (err) {
    console.error('[upload] Error:', err.message);
    return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

/* ------------------------------------------------------------------
   GET /api/download-clip/:clipId
   Streams the clip file directly to the browser as a download.
   ------------------------------------------------------------------ */
app.get('/api/download-clip/:clipId', (req, res) => {
  const { clipId } = req.params;

  let targetJob = null;
  for (const [, job] of activeJobs) {
    if (job.clipId === clipId) { targetJob = job; break; }
  }

  if (!targetJob || !targetJob.clipFile || !fs.existsSync(targetJob.clipFile)) {
    return res.status(404).json({ error: 'Clip not found or expired.' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="clip_${clipId}.mp4"`);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(targetJob.clipFile).pipe(res);
});

/* ------------------------------------------------------------------
   GET /healthz  — liveness probe
   ------------------------------------------------------------------ */
app.get('/healthz', (req, res) => {
  res.json({
    ok:         true,
    active_jobs: activeJobs.size,
    uptime:     process.uptime(),
  });
});

/* ==========================================================================
   SERVER START
   ========================================================================== */
const server = app.listen(PORT, () => {
  console.log(`Clipper server running on http://localhost:${PORT}`);
  console.log(`Max capture duration: ${MAX_CAPTURE_DURATION}s`);
  console.log(`Job TTL: ${JOB_TTL_MS / 1000}s`);
  console.log(`pomf upload endpoint: ${POMF_UPLOAD_URL}`);
});

/* ==========================================================================
   GRACEFUL SHUTDOWN  (mirrors server.js pattern)
   ========================================================================== */
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));