(function () {
  /* ── State ── */
  let SESSION_TOKEN = ''; // Loaded from sessionStorage; obtained via POST /login
  let activePlatform = 'youtube';
  let pollInterval = null;
  let currentJobId = null;
  let catboxUploading = false;
  let quaxUploading = false;
  let videyUploading = false;

  /* ── Elements ── */
  const captureCard   = document.getElementById('capture-card');
  const progressCard  = document.getElementById('progress-card');
  const resultCard    = document.getElementById('result-card');

  const chips         = document.querySelectorAll('.platform-chip');

  // Per-platform field wrappers and inputs
  const fields = {
    youtube: document.getElementById('field-youtube'),
    twitch:  document.getElementById('field-twitch'),
    kick:    document.getElementById('field-kick'),
  };
  const inputs = {
    youtube: document.getElementById('username-input-youtube'),
    twitch:  document.getElementById('username-input-twitch'),
    kick:    document.getElementById('username-input-kick'),
  };

  // Always returns the input for the currently active platform
  function getActiveInput() {
    return inputs[activePlatform];
  }

  const durationSlider = document.getElementById('duration-slider');
  const durationVal    = document.getElementById('duration-val');
  const qualitySelect  = document.getElementById('quality-select');
  const captureBtn     = document.getElementById('capture-btn');

  const jobIdLine      = document.getElementById('job-id-line');
  const statusBadge    = document.getElementById('status-badge');
  const statusMsg      = document.getElementById('status-msg');
  const progressFill   = document.getElementById('progress-fill');
  const progressPct    = document.getElementById('progress-pct');

  const clipPreview    = document.getElementById('clip-preview');
  const previewMeta    = document.getElementById('preview-meta');
  const downloadLink   = document.getElementById('download-link');

  const catboxBtn      = document.getElementById('catbox-btn');
  const catboxStatus   = document.getElementById('catbox-status');
  const catboxResult   = document.getElementById('catbox-result');
  const catboxUrlText  = document.getElementById('catbox-url-text');
  const catboxOpenLink = document.getElementById('catbox-open-link');

  const quaxBtn        = document.getElementById('quax-btn');
  const quaxStatus     = document.getElementById('quax-status');
  const quaxResult     = document.getElementById('quax-result');
  const quaxUrlText    = document.getElementById('quax-url-text');
  const quaxOpenLink   = document.getElementById('quax-open-link');

  const videyBtn       = document.getElementById('videy-btn');
  const videyStatus    = document.getElementById('videy-status');
  const videyResult    = document.getElementById('videy-result');
  const videyUrlText   = document.getElementById('videy-url-text');
  const videyOpenLink  = document.getElementById('videy-open-link');

  // errorBox holds the message text directly — there is no inner #error-text span
  const errorBox       = document.getElementById('error-box');

  const streamPreviewWrap    = document.getElementById('stream-preview-wrap');
  const streamPreviewIframe  = document.getElementById('stream-preview-iframe');
  const streamPreviewUnavail = document.getElementById('stream-preview-unavail');

  // Rewind control
  const rewindSlider  = document.getElementById('rewind-slider');
  const rewindVal     = document.getElementById('rewind-val');
  const rewindBadge   = document.getElementById('rewind-badge');
  const rewindHint    = document.getElementById('rewind-hint');

  /* ── Initialization ── */
  async function init() {
    try {
      // POST /login is open and returns a session token + config values.
      // /config is locked to Bearer (admin only) — the API key never hits the browser.
      const res    = await fetch('/api/clipper/login', { method: 'POST' });
      const config = await res.json();
      SESSION_TOKEN = config.sessionToken;
      console.log("Configuration loaded.");
    } catch (err) {
      console.error("Failed to load configuration:", err);
      showError("Could not load API configuration. Check your backend logs.");
    }
  }

  init();

  durationSlider.addEventListener('input', () => {
    durationVal.textContent = durationSlider.value + 's';
  });

  /* ── Rewind slider ── */
  function updateRewindUI() {
    const secs = parseInt(rewindSlider.value, 10);
    if (secs === 0) {
      rewindVal.textContent = '0s';
      rewindBadge.textContent = '';
      rewindBadge.classList.remove('rewound');
      // Rebuild badge content for "LIVE" (dot + text)
      const dot = document.createElement('span');
      dot.className = 'dot live-dot rewind-live-dot';
      rewindBadge.appendChild(dot);
      rewindBadge.appendChild(document.createTextNode(' LIVE'));
      rewindSlider.classList.remove('is-rewound');
      rewindHint.textContent = 'drag right to clip a moment from earlier in the stream';
    } else {
      const label = secs >= 60
        ? (secs % 60 === 0 ? `${secs / 60}m` : `${Math.floor(secs / 60)}m ${secs % 60}s`)
        : `${secs}s`;
      rewindVal.textContent = label;
      rewindBadge.innerHTML = '';
      // Rebuild badge content for rewound state (dot + text)
      const dot = document.createElement('span');
      dot.className = 'dot rewind-live-dot';
      rewindBadge.appendChild(dot);
      rewindBadge.appendChild(document.createTextNode(` −${label}`));
      rewindBadge.classList.add('rewound');
      rewindSlider.classList.add('is-rewound');
      rewindHint.textContent = `clip will start ${label} before you hit Capture`;
    }
  }
  rewindSlider.addEventListener('input', updateRewindUI);

  /* ── Platform switching ── */
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activePlatform = chip.dataset.platform;

      // Show only the matching field, hide the others
      Object.entries(fields).forEach(([platform, el]) => {
        if (el) el.style.display = platform === activePlatform ? '' : 'none';
      });

      updateStreamPreview();
    });
  });

  // Attach debounced preview update to every platform input
  Object.values(inputs).forEach(input => {
    if (input) input.addEventListener('input', debounce(updateStreamPreview, 800));
  });

  /* ── Actions ── */
  captureBtn.addEventListener('click', async () => {
    const username = getActiveInput().value.trim();
    if (!username) return alert('Please enter a username or URL');

    const payload = {
      platform: activePlatform,
      username: username,
      duration: parseInt(durationSlider.value),
      quality:  qualitySelect.value,
      rewindOffset: parseInt(rewindSlider.value, 10)
    };

    try {
      errorBox.classList.remove('visible');
      captureBtn.disabled = true;

      const res = await fetch('/api/clipper/clip', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Session ${SESSION_TOKEN}`
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start capture');

      currentJobId = data.jobId;
      startPolling(currentJobId);

    } catch (err) {
      showError(err.message);
      captureBtn.disabled = false;
    }
  });

  catboxBtn.addEventListener('click', async () => {
    if (!currentJobId || catboxUploading) return;
    catboxUploading = true;
    try {
      catboxBtn.disabled = true;
      catboxStatus.innerHTML = '<span class="spinner"></span> Uploading to Catbox...';

      const res = await fetch(`/api/clipper/clip/${currentJobId}/catbox`, {
        method: 'POST',
        headers: { 'Authorization': `Session ${SESSION_TOKEN}` }
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Catbox upload failed');

      catboxStatus.innerHTML = '✅ Uploaded!';
      catboxUrlText.textContent = data.url;
      catboxOpenLink.href = data.url;
      catboxResult.classList.add('visible');
    } catch (err) {
      catboxStatus.innerHTML = `❌ ${err.message}`;
      catboxBtn.disabled = false;
      catboxUploading = false;
    }
  });

  quaxBtn.addEventListener('click', async () => {
    if (!currentJobId || quaxUploading) return;
    quaxUploading = true;
    try {
      quaxBtn.disabled = true;
      quaxStatus.innerHTML = '<span class="spinner"></span> Uploading to qu.ax...';

      const res = await fetch(`/api/clipper/clip/${currentJobId}/quax`, {
        method: 'POST',
        headers: { 'Authorization': `Session ${SESSION_TOKEN}` }
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'qu.ax upload failed');

      quaxStatus.innerHTML = '✅ Uploaded!';
      quaxUrlText.textContent = data.url;
      quaxOpenLink.href = data.url;
      quaxResult.classList.add('visible');
    } catch (err) {
      quaxStatus.innerHTML = `❌ ${err.message}`;
      quaxBtn.disabled = false;
      quaxUploading = false;
    }
  });

  videyBtn.addEventListener('click', async () => {
    if (!currentJobId || videyUploading) return;
    videyUploading = true;
    try {
      videyBtn.disabled = true;
      videyStatus.innerHTML = '<span class="spinner"></span> Uploading to Videy...';

      const res = await fetch(`/api/clipper/clip/${currentJobId}/videy`, {
        method: 'POST',
        headers: { 'Authorization': `Session ${SESSION_TOKEN}` }
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Videy upload failed');

      videyStatus.innerHTML = '✅ Uploaded!';
      videyUrlText.textContent = data.url;
      videyOpenLink.href = data.url;
      videyResult.classList.add('visible');
    } catch (err) {
      videyStatus.innerHTML = `❌ ${err.message}`;
      videyBtn.disabled = false;
      videyUploading = false;
    }
  });

  // #cancel-btn is in the progress card; #new-clip-btn is in the result card
  document.getElementById('cancel-btn').addEventListener('click', reset);
  document.getElementById('new-clip-btn').addEventListener('click', reset);

  /* ── Helpers ── */
  function startPolling(jobId) {
    captureCard.style.display = 'none';
    progressCard.classList.add('visible');
    jobIdLine.textContent = jobId;
    setStatus('processing', 'Initializing capture...');

    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/clipper/clip/${jobId}`);
        const job = await res.json();

        if (job.status === 'ready') {
          clearInterval(pollInterval);
          showResult(job);
        } else if (job.status === 'error') {
          clearInterval(pollInterval);
          showError(job.error || 'Processing failed');
          progressFill.classList.add('err');
        } else {
          const pct = job.progress || 0;
          progressFill.style.width = pct + '%';
          progressPct.textContent = Math.round(pct) + '%';
          if (pct > 0) {
            setStatus('processing', job.stage || 'Ripping segments...');
          }
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    }, 2000);
  }

  function showResult(job) {
    progressFill.style.width = '100%';
    progressPct.textContent = '100%';
    progressFill.classList.add('done');

    setTimeout(() => {
      progressCard.classList.remove('visible');
      resultCard.classList.add('visible');

      const clipUrl = job.downloadUrl || `/clips/clip_${job.id}.mp4`;
      const filename = clipUrl.split('/').pop();
      clipPreview.src = clipUrl;
      clipPreview.muted = true;
      clipPreview.load();
      clipPreview.play().catch(() => {});
      downloadLink.href = clipUrl;
      downloadLink.download = filename;

      clipPreview.addEventListener('loadedmetadata', () => {
        const duration = clipPreview.duration;
        const timeStr = duration ? Math.floor(duration) + 's' : job.duration + 's';
        previewMeta.innerHTML = `<span class="meta-pill green">✓ ready</span>
          <span class="meta-pill">${job.platform}</span>
          <span class="meta-pill">${timeStr}</span>`;
      }, { once: true });
    }, 800);
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
    // Clear all three platform inputs
    Object.values(inputs).forEach(input => { if (input) input.value = ''; });
    // Reset rewind slider to live
    rewindSlider.value = 0;
    updateRewindUI();
    catboxBtn.disabled = false;
    catboxUploading = false;
    catboxStatus.innerHTML = '';
    catboxResult.classList.remove('visible');
    catboxUrlText.textContent = '';
    catboxOpenLink.href = '#';
    quaxBtn.disabled = false;
    quaxUploading = false;
    quaxStatus.innerHTML = '';
    quaxResult.classList.remove('visible');
    quaxUrlText.textContent = '';
    quaxOpenLink.href = '#';
    videyBtn.disabled = false;
    videyUploading = false;
    videyStatus.innerHTML = '';
    videyResult.classList.remove('visible');
    videyUrlText.textContent = '';
    videyOpenLink.href = '#';
    captureBtn.disabled = false;
    currentJobId = null;
  }

  function setStatus(state, msgHtml) {
    statusBadge.className = 'status-badge ' + state;
    statusBadge.textContent = state.toUpperCase();
    statusMsg.innerHTML = msgHtml;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('visible');
    captureBtn.disabled = false;
  }

  function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
  }

  function updateStreamPreview() {
    const val = getActiveInput().value.trim();
    if (!val) {
      streamPreviewWrap.classList.remove('visible');
      return;
    }

    let embedUrl = '';
    if (activePlatform === 'twitch') {
      let twitchChannel = val;
      try {
        const u = new URL(val);
        if (u.hostname.includes('twitch.tv')) {
          twitchChannel = u.pathname.replace(/^\//, '').split('/')[0];
        }
      } catch (_) {}
      embedUrl = `https://player.twitch.tv/?channel=${twitchChannel}&parent=${window.location.hostname}&muted=true`;
    } else if (activePlatform === 'kick') {
      let kickSlug = val;
      try { kickSlug = new URL(val).pathname.replace(/^\//, '').split('/')[0]; } catch (_) {}
      embedUrl = `https://player.kick.com/${kickSlug}`;
    } else if (activePlatform === 'youtube') {
      const ytId = extractYoutubeId(val);
      if (ytId) embedUrl = `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=1`;
    }

    if (embedUrl) {
      streamPreviewIframe.src = embedUrl;
      streamPreviewWrap.classList.add('visible');
      streamPreviewUnavail.classList.remove('visible');
    } else {
      streamPreviewWrap.classList.remove('visible');
    }
  }

  function extractYoutubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  }

})();

/* ════════════════════════════════════════
   Having trouble? — modal
   ════════════════════════════════════════ */
(function () {
  var modal    = document.getElementById('trouble-modal');
  var openBtn  = document.getElementById('trouble-btn');
  var closeBtn = document.getElementById('trouble-close');
  var gotIt    = document.getElementById('trouble-got-it');

  if (!modal || !openBtn) return; // guard if elements are missing

  function openModal()  { modal.classList.add('open');    document.body.style.overflow = 'hidden'; }
  function closeModal() { modal.classList.remove('open'); document.body.style.overflow = ''; }

  openBtn .addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  gotIt   .addEventListener('click', closeModal);

  // Close on backdrop click
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });
})();