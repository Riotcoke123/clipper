(function () {
  /* ── State ── */
  let API_KEY = ''; // Loaded dynamically from /api/clipper/config
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

  const clipPreview   = document.getElementById('clip-preview');
  const previewMeta   = document.getElementById('preview-meta');
  // FIX #3: was 'download-btn' — the HTML element is 'download-link'
  const downloadLink  = document.getElementById('download-link');

  const catboxBtn     = document.getElementById('catbox-btn');
  const catboxStatus  = document.getElementById('catbox-status');
  const catboxResult  = document.getElementById('catbox-result');
  const catboxUrlText = document.getElementById('catbox-url-text');
  const catboxOpenLink = document.getElementById('catbox-open-link');

  const quaxBtn       = document.getElementById('quax-btn');
  const quaxStatus    = document.getElementById('quax-status');
  const quaxResult    = document.getElementById('quax-result');
  const quaxUrlText   = document.getElementById('quax-url-text');
  const quaxOpenLink  = document.getElementById('quax-open-link');

  // FIX #5: was getElementById('error-text') which doesn't exist in HTML.
  // errorBox itself holds the message text.
  const errorBox      = document.getElementById('error-box');

  const streamPreviewWrap    = document.getElementById('stream-preview-wrap');
  const streamPreviewIframe  = document.getElementById('stream-preview-iframe');
  const streamPreviewUnavail = document.getElementById('stream-preview-unavail');

  /* ── Initialization ── */
  async function init() {
    try {
      const res = await fetch('/api/clipper/config');
      const config = await res.json();
      API_KEY = config.apiKey;
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

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activePlatform = chip.dataset.platform;
      usernameInput.placeholder = PLATFORM_HINTS[activePlatform];
      platformHint.textContent = PLATFORM_HINTS[activePlatform];
      updateStreamPreview();
    });
  });

  usernameInput.addEventListener('input', debounce(updateStreamPreview, 800));

  /* ── Actions ── */
  captureBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    if (!username) return alert('Please enter a username or URL');

    const payload = {
      platform: activePlatform,
      username: username,
      duration: parseInt(durationSlider.value),
      quality:  qualitySelect.value
    };

    try {
      errorBox.classList.remove('visible');
      captureBtn.disabled = true;

      const res = await fetch('/api/clipper/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
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
    if (!currentJobId) return;
    try {
      catboxBtn.disabled = true;
      catboxStatus.innerHTML = '<span class="spinner"></span> Uploading to Catbox...';

      const res = await fetch(`/api/clipper/clip/${currentJobId}/catbox`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}` }
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
    }
  });

  quaxBtn.addEventListener('click', async () => {
    if (!currentJobId) return;
    try {
      quaxBtn.disabled = true;
      quaxStatus.innerHTML = '<span class="spinner"></span> Uploading to qu.ax...';

      const res = await fetch(`/api/clipper/clip/${currentJobId}/quax`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}` }
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
    }
  });

  // FIX #4: was getElementById('reset-btn') which doesn't exist.
  // The HTML has 'cancel-btn' (progress card) and 'new-clip-btn' (result card).
  document.getElementById('cancel-btn').addEventListener('click', reset);
  document.getElementById('new-clip-btn').addEventListener('click', reset);

  /* ── Helpers ── */
  function startPolling(jobId) {
    captureCard.style.display = 'none';
    progressCard.classList.add('visible');
    jobIdLine.textContent = jobId;
    setStatus('processing', '<span class="spinner"></span> Initializing capture...');

    pollInterval = setInterval(async () => {
      try {
        // FIX #1: was '/api/clipper/status/${jobId}' — route doesn't exist.
        // Correct endpoint is '/api/clipper/clip/:jobId'.
        const res = await fetch(`/api/clipper/clip/${jobId}`);
        const job = await res.json();

        // FIX #2: backend uses 'ready' and 'error', not 'completed' and 'failed'.
        if (job.status === 'ready') {
          clearInterval(pollInterval);
          showResult(job);
        } else if (job.status === 'error') {
          clearInterval(pollInterval);
          setStatus('error', '');
          showError(job.error || 'Processing failed');
          progressFill.classList.add('err');
        } else {
          const pct = job.progress || 0;
          progressFill.style.width = pct + '%';
          progressPct.textContent = Math.round(pct) + '%';
          const stageLabel = {
            resolving:  'Resolving stream URL…',
            capturing:  'Ripping segments…',
            encoding:   'Encoding clip…',
          }[job.status] || 'Working…';
          setStatus('processing', `<span class="spinner"></span> ${stageLabel}`);
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

      // FIX #6: was 'job.filename' which doesn't exist — backend provides 'downloadUrl'.
      const clipUrl = job.downloadUrl || `/clips/clip_${job.id}.mp4`;
      const filename = clipUrl.split('/').pop();

      clipPreview.src = clipUrl;
      downloadLink.href = clipUrl;
      downloadLink.download = filename;

      clipPreview.addEventListener('loadedmetadata', () => {
        const dur = clipPreview.duration;
        const timeStr = dur ? Math.floor(dur) + 's' : (job.duration || 0) + 's';
        previewMeta.innerHTML =
          `<span class="meta-pill green">✓ ready</span>` +
          `<span class="meta-pill">${job.platform}</span>` +
          `<span class="meta-pill">${timeStr}</span>`;
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
    captureBtn.disabled = false;
    currentJobId = null;
  }

  function setStatus(state, msgHtml) {
    statusBadge.className = 'status-badge ' + state;
    statusBadge.textContent = state.toUpperCase();
    statusMsg.innerHTML = msgHtml;
  }

  // FIX #5: was 'errorText.textContent = msg' where errorText was null.
  // Write directly into errorBox instead.
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
    const val = usernameInput.value.trim();
    if (!val) {
      streamPreviewWrap.classList.remove('visible');
      return;
    }

    let embedUrl = '';
    if (activePlatform === 'twitch') {
      embedUrl = `https://player.twitch.tv/?channel=${val}&parent=${window.location.hostname}&muted=true`;
    } else if (activePlatform === 'kick') {
      embedUrl = `https://player.kick.com/${val}`;
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