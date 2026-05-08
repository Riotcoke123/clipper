(function () {
  /* ── State ── */
  let activePlatform = 'youtube';
  let pollInterval = null;
  let currentJobId = null;

  const PLATFORM_HINTS = {
    youtube: 'paste a full live URL',
    twitch:  'e.g. xqc',
    kick:    'e.g. xqc',
    odysee:  'e.g. @DistroWatch — or paste an Odysee channel URL',
  };

  /* ── Elements ── */
  const captureCard   = document.getElementById('capture-card');
  const progressCard  = document.getElementById('progress-card');
  const resultCard    = document.getElementById('result-card');

  const chips         = document.querySelectorAll('.platform-chip');
  const usernameInput = document.getElementById('username-input');
  const platformHint  = document.getElementById('platform-hint');
  const durationSlider = document.getElementById('duration-slider');
  const durationVal   = document.getElementById('duration-val');
  const qualitySelect = document.getElementById('quality-select');
  const captureBtn    = document.getElementById('capture-btn');

  const jobIdLine     = document.getElementById('job-id-line');
  const statusBadge   = document.getElementById('status-badge');
  const statusMsg     = document.getElementById('status-msg');
  const progressFill  = document.getElementById('progress-fill');
  const progressPct   = document.getElementById('progress-pct');
  const errorBox      = document.getElementById('error-box');
  const cancelBtn     = document.getElementById('cancel-btn');

  const downloadLink  = document.getElementById('download-link');
  const newClipBtn    = document.getElementById('new-clip-btn');
  const clipPreview   = document.getElementById('clip-preview');
  const previewMeta   = document.getElementById('preview-meta');

  const streamPreviewWrap    = document.getElementById('stream-preview-wrap');
  const streamPreviewIframe  = document.getElementById('stream-preview-iframe');
  const streamPreviewUnavail = document.getElementById('stream-preview-unavail');
  const streamPreviewPlatform = document.getElementById('stream-preview-platform');

  /* ── Embed URL builder ── */
  function getEmbedUrl(platform, input) {
    const v = input.trim();
    if (!v) return null;
    switch (platform) {
      case 'twitch': {
        // strip full URL down to channel name
        const user = v.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0] || v;
        if (!user) return null;
        const parent = window.location.hostname || 'localhost';
        return `https://player.twitch.tv/?channel=${encodeURIComponent(user)}&parent=${parent}&autoplay=true&muted=true`;
      }
      case 'kick': {
        const user = v.replace(/^https?:\/\/(www\.)?kick\.com\//i, '').split(/[/?#]/)[0] || v;
        if (!user) return null;
        return `https://player.kick.com/${encodeURIComponent(user)}`;
      }
      case 'youtube': {
        // Extract video ID from all common YouTube URL formats:
        //   watch?v=ID, /live/ID, youtu.be/ID, /shorts/ID, /embed/ID, /v/ID
        const m = v.match(/(?:[?&]v=|\/(?:live|shorts|embed|v)\/)([a-zA-Z0-9_-]{11})|youtu\.be\/([a-zA-Z0-9_-]{11})/);
        const videoId = m && (m[1] || m[2]);
        if (videoId) {
          const origin = encodeURIComponent(window.location.origin || 'http://localhost');
          return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&enablejsapi=1&origin=${origin}`;
        }
        return null; // channel handle or @/live URL — can't embed without a video ID
      }
      case 'odysee': {
        // Odysee embed uses /$/embed/<name>/<claimId>
        // Full URL formats:
        //   odysee.com/@Channel:id/video-name:claimId  → embed video claim
        //   odysee.com/@Channel:id                     → embed channel (shows live/latest)
        const clean = v.replace(/^https?:\/\/(www\.)?odysee\.com\//i, '');
        if (!clean) return null;
        // Video claim inside a channel: @Channel:abc/my-video:def
        const videoMatch = clean.match(/^@[^/]+\/([^/:]+):([a-f0-9]+)/i);
        if (videoMatch) {
          return `https://odysee.com/$/embed/${videoMatch[1]}/${videoMatch[2]}?autoplay=1&muted=1`;
        }
        // Channel-only: @Channel:claimId
        const channelMatch = clean.match(/^(@[^/:]+):([a-f0-9]+)/i);
        if (channelMatch) {
          return `https://odysee.com/$/embed/${channelMatch[1]}/${channelMatch[2]}?autoplay=1&muted=1`;
        }
        return null; // username-only — Odysee needs a full URL with claim ID
      }
      default:
        return null;
    }
  }

  /* ── Stream preview updater (debounced) ── */
  let previewDebounce = null;
  function schedulePreviewUpdate() {
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(updateStreamPreview, 600);
  }

  /* ── YouTube iframe error listener (catches Error 153 = not embeddable) ── */
  // YouTube only sends postMessage error events when the player has an active
  // subscription. We trigger that by sending a 'listening' ping to the iframe
  // after it loads. Without this, YouTube renders its own Error 153 screen
  // inside the iframe instead of letting us intercept and show our fallback.
  streamPreviewIframe.addEventListener('load', () => {
    if (activePlatform !== 'youtube') return;
    try {
      streamPreviewIframe.contentWindow.postMessage(
        JSON.stringify({ event: 'listening', id: 1 }),
        'https://www.youtube.com'
      );
    } catch (_) {}
  });

  // YouTube sends JSON postMessages when the player state changes.
  // Error codes: 2=bad videoId, 5=HTML5 error, 100=not found,
  //              101/150=not embeddable, 153=playback disallowed.
  window.addEventListener('message', (evt) => {
    if (!evt.data) return;
    // Only care about messages from YouTube
    if (evt.origin && evt.origin !== 'https://www.youtube.com') return;
    let msg;
    try { msg = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data; } catch (_) { return; }

    const isYTError = msg?.event === 'onError'
      || (msg?.event === 'infoDelivery' && msg?.info?.error);
    if (!isYTError) return;

    const errCode = msg?.info?.error ?? msg?.info;
    if ([2, 5, 100, 101, 150, 153].includes(errCode)) {
      // Embedding blocked (101/150/153) or unplayable (2/5/100):
      // silently collapse the preview — no error banner, clipping is unaffected.
      streamPreviewWrap.classList.remove('visible');
      streamPreviewIframe.src = 'about:blank';
      streamPreviewUnavail.classList.remove('visible');
    }
  });

  function updateStreamPreview() {
    const v = usernameInput.value.trim();
    if (!v) {
      streamPreviewWrap.classList.remove('visible');
      streamPreviewIframe.src = 'about:blank';
      return;
    }
    const embedUrl = getEmbedUrl(activePlatform, v);
    streamPreviewWrap.classList.add('visible');
    streamPreviewPlatform.textContent = activePlatform;

    if (embedUrl) {
      streamPreviewIframe.src = embedUrl;
      streamPreviewIframe.style.display = '';
      streamPreviewUnavail.classList.remove('visible');
    } else {
      streamPreviewIframe.src = 'about:blank';
      streamPreviewIframe.style.display = 'none';
      const msgs = {
        odysee: 'Paste a full Odysee URL (with claim ID) to preview — e.g. odysee.com/@Channel:id',
        youtube: 'Paste a full YouTube live URL to preview — e.g. youtube.com/watch?v=...',
      };
      streamPreviewUnavail.textContent = msgs[activePlatform] || 'No embed available — clip will still work.';
      streamPreviewUnavail.classList.add('visible');
    }
  }
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activePlatform = chip.dataset.platform;
      platformHint.textContent = PLATFORM_HINTS[activePlatform] || '';
      schedulePreviewUpdate();
    });
  });

  /* ── Auto-detect platform from pasted URL ── */
  usernameInput.addEventListener('input', () => {
    const v = usernameInput.value.trim();
    const map = {
      'youtube.com': 'youtube',
      'youtu.be':    'youtube',
      'twitch.tv':   'twitch',
      'kick.com':    'kick',
      'odysee.com':  'odysee',
    };
    for (const [host, platform] of Object.entries(map)) {
      if (v.includes(host)) {
        chips.forEach(c => c.classList.remove('active'));
        const chip = document.querySelector(`[data-platform="${platform}"]`);
        if (chip) chip.classList.add('active');
        activePlatform = platform;
        platformHint.textContent = PLATFORM_HINTS[platform];
        break;
      }
    }
    schedulePreviewUpdate();
  });

  /* ── Duration slider ── */
  durationSlider.addEventListener('input', () => {
    durationVal.textContent = durationSlider.value + 's';
  });

  /* ── Capture button ── */
  captureBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    if (!username) {
      usernameInput.focus();
      usernameInput.style.borderColor = 'var(--red)';
      setTimeout(() => { usernameInput.style.borderColor = ''; }, 1200);
      return;
    }

    const payload = {
      platform: activePlatform,
      username,
      duration: parseInt(durationSlider.value, 10),
      quality:  qualitySelect.value,
    };

    showProgress();
    setStatus('pending', '<span class="spinner"></span> Submitting job…');

    try {
      const res = await fetch('/api/clipper/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Request failed');

      jobIdLine.textContent = 'job: ' + data.jobId;
      currentJobId = data.jobId;
      startPolling(data.jobId);
    } catch (err) {
      setStatus('error', 'Submit failed');
      showError(err.message);
    }
  });

  const catboxBtn      = document.getElementById('catbox-btn');
  const catboxStatus   = document.getElementById('catbox-status');
  const catboxResult   = document.getElementById('catbox-result');
  const catboxOpenLink = document.getElementById('catbox-open-link');
  const catboxUrlText  = document.getElementById('catbox-url-text');

  const quaxBtn      = document.getElementById('quax-btn');
  const quaxStatus   = document.getElementById('quax-status');
  const quaxResult   = document.getElementById('quax-result');
  const quaxOpenLink = document.getElementById('quax-open-link');
  const quaxUrlText  = document.getElementById('quax-url-text');

  /* ── Catbox upload ── */
  catboxBtn.addEventListener('click', async () => {
    catboxBtn.disabled = true;
    catboxStatus.innerHTML = '<span class="spinner"></span> Uploading to Catbox…';

    try {
      if (!currentJobId) throw new Error('No clip job active');

      const res = await fetch(`/api/clipper/clip/${currentJobId}/catbox`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

      catboxOpenLink.href = data.url;
      catboxUrlText.textContent = data.url;
      catboxResult.classList.add('visible');
      catboxStatus.innerHTML = '<span class="catbox-success">✓ Uploaded!</span>';
    } catch (err) {
      catboxStatus.innerHTML = `<span class="catbox-err">! ${err.message}</span>`;
      catboxBtn.disabled = false;
    }
  });

  /* ── qu.ax upload ── */
  quaxBtn.addEventListener('click', async () => {
    quaxBtn.disabled = true;
    quaxStatus.innerHTML = '<span class="spinner"></span> Uploading to qu.ax…';

    try {
      if (!currentJobId) throw new Error('No clip job active');

      const res = await fetch(`/api/clipper/clip/${currentJobId}/quax`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

      quaxOpenLink.href = data.url;
      quaxUrlText.textContent = data.url;
      quaxResult.classList.add('visible');
      quaxStatus.innerHTML = '<span class="catbox-success">✓ Uploaded!</span>';
    } catch (err) {
      quaxStatus.innerHTML = `<span class="catbox-err">! ${err.message}</span>`;
      quaxBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', reset);
  newClipBtn.addEventListener('click', reset);

  /* ── Polling ── */
  function startPolling(jobId) {
    clearInterval(pollInterval);
    pollInterval = setInterval(() => pollJob(jobId), 1200);
    pollJob(jobId);
  }

  async function pollJob(jobId) {
    try {
      const res = await fetch(`/api/clipper/clip/${jobId}`);
      if (!res.ok) return;
      const job = await res.json();
      applyJobState(job);
    } catch (_) {}
  }

  function applyJobState(job) {
    const pct = Math.round(job.progress || 0);
    progressFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';

    const msgMap = {
      pending:    '<span class="spinner"></span> Queued…',
      resolving:  '<span class="spinner"></span> Resolving stream URL…',
      capturing:  '<span class="spinner"></span> Capturing from ' + job.platform + '…',
      encoding:   '<span class="spinner"></span> Encoding clip…',
      ready:      '<span class="spinner green"></span> Done!',
      error:      'Failed.',
    };
    setStatus(job.status, msgMap[job.status] || job.status);

    if (job.status === 'ready') {
      clearInterval(pollInterval);
      progressFill.classList.add('done');
      setTimeout(() => showResult(job), 600);
    }

    if (job.status === 'error') {
      clearInterval(pollInterval);
      progressFill.classList.add('err');
      showError(job.error || 'Unknown error');
    }
  }

  /* ── UI helpers ── */
  function showProgress() {
    captureCard.style.display = 'none';
    progressCard.classList.add('visible');
    resultCard.classList.remove('visible');
    errorBox.classList.remove('visible');
    progressFill.style.width = '0%';
    progressFill.classList.remove('done', 'err');
    progressPct.textContent = '0%';
    jobIdLine.textContent = 'job: —';
  }

  function showResult(job) {
    progressCard.classList.remove('visible');
    resultCard.classList.add('visible');
    const downloadUrl = `/api/clipper/clip/${job.id}/download`;
    downloadLink.href = downloadUrl;

    // Video preview — use the static clips URL so it doesn't trigger delete
    const previewSrc = job.downloadUrl || downloadUrl;
    clipPreview.src = previewSrc;
    clipPreview.muted = true;          // allow autoplay in all browsers
    clipPreview.autoplay = true;
    clipPreview.load();

    // Show an inline error if the video fails to load
    clipPreview.addEventListener('error', () => {
      previewMeta.innerHTML = `<span class="meta-pill" style="color:var(--red)">⚠ Preview failed — use Download</span>`;
    }, { once: true });

    // Build meta line once video metadata is available
    previewMeta.innerHTML = `<span class="meta-pill green">✓ ready</span>
      <span class="meta-pill">${job.platform}</span>
      <span class="meta-pill">${job.duration}s</span>`;

    clipPreview.addEventListener('loadedmetadata', () => {
      const dur = clipPreview.duration;
      if (dur && isFinite(dur)) {
        const mins = Math.floor(dur / 60);
        const secs = Math.floor(dur % 60).toString().padStart(2, '0');
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        // replace duration pill with actual video duration
        previewMeta.innerHTML = `<span class="meta-pill green">✓ ready</span>
          <span class="meta-pill">${job.platform}</span>
          <span class="meta-pill">${timeStr}</span>`;
      }
    }, { once: true });
  }

  function reset() {
    clearInterval(pollInterval);
    captureCard.style.display = '';
    progressCard.classList.remove('visible');
    resultCard.classList.remove('visible');
    errorBox.classList.remove('visible');
    progressFill.style.width = '0%';
    progressFill.classList.remove('done', 'err');
    clipPreview.src = '';
    previewMeta.innerHTML = '';
    streamPreviewWrap.classList.remove('visible');
    streamPreviewIframe.src = 'about:blank';
    streamPreviewUnavail.classList.remove('visible');
    usernameInput.value = '';
    catboxBtn.disabled = false;
    catboxStatus.innerHTML = '';
    catboxResult.classList.remove('visible');
    catboxUrlText.textContent = '';
    catboxOpenLink.href = '#';
    quaxBtn.disabled = false;
    quaxStatus.innerHTML = '';
    quaxResult.classList.remove('visible');
    quaxUrlText.textContent = '';
    quaxOpenLink.href = '#';
    currentJobId = null;
  }

  function setStatus(state, msgHtml) {
    statusBadge.className = 'status-badge ' + state;
    statusBadge.textContent = state;
    statusMsg.innerHTML = msgHtml;
  }

  function showError(msg) {
    errorBox.textContent = '! ' + msg;
    errorBox.classList.add('visible');
  }
})();