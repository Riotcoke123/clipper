require('dotenv').config();
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

const app  = express();
const PORT = process.env.PORT || 5000;
const MAX_CAPTURE_DURATION = Number(process.env.MAX_CAPTURE_DURATION || 240);
const JOB_TTL_MS = Number(process.env.JOB_TTL_SECONDS || 3600) * 1000;
const CATBOX_UPLOAD_URL = process.env.CATBOX_UPLOAD_URL || 'https://catbox.moe/user/api.php';
const CATBOX_MAX_BYTES = 200 * 1024 * 1024;
const BUZZHEAVIER_UPLOAD_BASE = process.env.BUZZHEAVIER_UPLOAD_BASE || 'https://w.buzzheavier.com';
const FILEDITCH_UPLOAD_URL = process.env.FILEDITCH_UPLOAD_URL || 'https://new.fileditch.com/upload.php';
const tempDir  = path.join(__dirname, 'temp');
const clipsDir = path.join(__dirname, 'public', 'clips');
for (const dir of [tempDir, clipsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeJobs = new Map();

function scheduleJobCleanup(captureId) {
  setTimeout(() => {
    const job = activeJobs.get(captureId);
    if (!job) return;

    for (const key of ['outputFile', 'previewFile', 'clipFile']) {
      if (job[key] && fs.existsSync(job[key])) {
        fs.unlink(job[key], () => {});
      }
    }
    activeJobs.delete(captureId);
    console.log(`[cleanup] Job ${captureId} removed.`);
  }, JOB_TTL_MS);
}

function ytDlpFormat(quality) {
  switch (quality) {
    case 'low':    return 'worst[height>=480]/worst';
    case 'medium': return 'best[height<=720]/best[height<=720]';
    case 'high':   return 'best[height<=1080]/best[height<=1080]';
    default:       return 'best/best';
  }
}

// *
// * Returns true when a job exists AND has reached one of the given statuses.

function jobIs(captureId, ...statuses) {
  const job = activeJobs.get(captureId);
  return job && statuses.includes(job.status);
}

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

// ------------------------------------------------------------------
app.post('/api/upload-clip', async (req, res) => {
  try {
    const { clipId, site = 'catbox' } = req.body;

    if (!clipId) {
      return res.status(400).json({ error: 'clipId is required.' });
    }
    if (!['catbox', 'buzzheavier', 'fileditch'].includes(site)) {
      return res.status(400).json({ error: 'site must be "catbox", "buzzheavier", or "fileditch".' });
    }

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

    const { size: fileSize } = fs.statSync(targetJob.clipFile);
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

    if (site === 'catbox' && fileSize > CATBOX_MAX_BYTES) {
      return res.status(413).json({
        error: `Clip exceeds catbox.moe's 200 MB limit (file is ${fileSizeMB} MB). Try site=buzzheavier or site=fileditch instead.`,
      });
    }

    targetJob.status   = 'uploading';
    targetJob.progress = 0;

    console.log(`[upload] Uploading clip ${clipId} to ${site} (${fileSizeMB} MB)`);

    let uploadUrl;

    if (site === 'catbox') {
      // Anonymous upload: omit userhash
      // reqtype=fileupload  fileToUpload=<file data>
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('fileToUpload', fs.createReadStream(targetJob.clipFile), {
        filename:    `clip_${clipId}.mp4`,
        contentType: 'video/mp4',
      });

      const catboxRes = await axios.post(CATBOX_UPLOAD_URL, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
        onUploadProgress: (evt) => {
          if (evt.total) {
            targetJob.progress = Math.round((evt.loaded / evt.total) * 100);
          }
        },
      });

      uploadUrl = (catboxRes.data || '').toString().trim();
      if (!uploadUrl.startsWith('https://')) {
        throw new Error(`catbox.moe returned an unexpected response: ${uploadUrl}`);
      }

    } else if (site === 'buzzheavier') {
      // Anonymous PUT upload — equivalent to:
      //   curl -#o - -T "clip.mp4" "https://w.buzzheavier.com/clip.mp4"
      const filename   = `clip_${clipId}.mp4`;
      const uploadEndpoint = `${BUZZHEAVIER_UPLOAD_BASE}/${filename}`;

      const buzzRes = await axios.put(
        uploadEndpoint,
        fs.createReadStream(targetJob.clipFile),
        {
          headers: {
            'Content-Type':   'video/mp4',
            'Content-Length': fileSize,
          },
          maxContentLength: Infinity,
          maxBodyLength:    Infinity,
          onUploadProgress: (evt) => {
            if (evt.total) {
              targetJob.progress = Math.round((evt.loaded / evt.total) * 100);
            }
          },
        }
      );

      // Response may be JSON { url } or plain-text URL
      const raw = buzzRes.data;
      if (raw && typeof raw === 'object' && raw.url) {
        uploadUrl = raw.url.toString().trim();
      } else {
        uploadUrl = (raw || '').toString().trim();
      }

      if (!uploadUrl.startsWith('https://')) {
        throw new Error(`buzzheavier.com returned an unexpected response: ${uploadUrl}`);
      }

    } else {
      // Anonymous raw-body PUT — equivalent to:
      //   curl -T clip.mp4 "https://new.fileditch.com/upload.php?filename=clip.mp4"
      const filename = `clip_${clipId}.mp4`;
      const uploadEndpoint = `${FILEDITCH_UPLOAD_URL}?filename=${encodeURIComponent(filename)}`;

      const ditchRes = await axios.put(
        uploadEndpoint,
        fs.createReadStream(targetJob.clipFile),
        {
          headers: {
            'Content-Type':   'video/mp4',
            'Content-Length': fileSize,
          },
          maxContentLength: Infinity,
          maxBodyLength:    Infinity,
          onUploadProgress: (evt) => {
            if (evt.total) {
              targetJob.progress = Math.round((evt.loaded / evt.total) * 100);
            }
          },
        }
      );

      // fileditch returns JSON: { files: [{ url, name, size, ... }] }
      const ditchData = ditchRes.data;
      if (!ditchData?.files?.length || !ditchData.files[0].url) {
        throw new Error(`fileditch.com returned an unexpected response: ${JSON.stringify(ditchData)}`);
      }
      uploadUrl = ditchData.files[0].url.toString().trim();

      if (!uploadUrl.startsWith('https://')) {
        throw new Error(`fileditch.com returned an invalid URL: ${uploadUrl}`);
      }
    }

    targetJob.status    = 'uploaded';
    targetJob.progress  = 100;
    targetJob.uploadUrl = uploadUrl;

    console.log(`[upload] Done (${site}) — ${uploadUrl}`);
    return res.json({ success: true, url: uploadUrl, site });

  } catch (err) {
    console.error('[upload] Error:', err.message);
    return res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

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

app.get('/healthz', (req, res) => {
  res.json({
    ok:         true,
    active_jobs: activeJobs.size,
    uptime:     process.uptime(),
  });
});


const server = app.listen(PORT, () => {
  console.log(`Clipper server running on http://localhost:${PORT}`);
  console.log(`Max capture duration: ${MAX_CAPTURE_DURATION}s`);
  console.log(`Job TTL: ${JOB_TTL_MS / 1000}s`);
  console.log(`catbox upload endpoint:      ${CATBOX_UPLOAD_URL}`);
  console.log(`buzzheavier upload base:     ${BUZZHEAVIER_UPLOAD_BASE}`);
  console.log(`fileditch upload endpoint:   ${FILEDITCH_UPLOAD_URL}`);
});


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