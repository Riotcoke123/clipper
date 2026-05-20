(function () {
  /* ── State ── */
  let API_KEY = ''; // Loaded dynamically from /api/clipper/config
  let activePlatform = 'youtube';
  let pollInterval = null;
  let currentJobId = null;
  let catboxUploading = false;
  let quaxUploading = false;
  let videyUploading = false;

  const PLATFORM_META = {
    youtube: {
      label:       'YouTube full stream URL',
      placeholder: 'https://www.youtube.com/watch?v=...',
      hint:        'paste a full live URL',
    },
    twitch: {
      label:       'Twitch channel URL or username',
      placeholder: 'https://www.twitch.tv/username  or  username',
      hint:        'e.g. https://www.twitch.tv/milkypuff  or  milkypuff',
    },
    kick: {
      label:       'Kick username',
      placeholder: 'kick.com/username',
      hint:        'paste kick.com/username',
    },
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
  const downloadLink  = document.getElementById('download-link'); // was 'download-btn' — doesn't exist

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

  const videyBtn      = document.getElementById('videy-btn');
  const videyStatus   = document.getElementById('videy-status');
  const videyResult   = document.getElementById('videy-result');
  const videyUrlText  = document.getElementById('videy-url-text');
  const videyOpenLink = document.getElementById('videy-open-link');

  // errorBox holds the message text directly — there is no inner #error-text span
  const errorBox      = document.getElementById('error-box');

  const streamPreviewWrap   = document.getElementById('stream-preview-wrap');
  const streamPreviewIframe = document.getElementById('stream-preview-iframe');
  const streamPreviewUnavail = document.getElementById('stream-preview-unavail');

  /* ── Initialization ── */
  async function init() {
    try {
      // Get the key from your .env via the backend bridge
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

  const urlLabel = document.getElementById('url-label');

  function applyPlatformMeta(platform) {
    const meta = PLATFORM_META[platform];
    if (!meta) return;
    if (urlLabel)       urlLabel.textContent      = meta.label;
    if (usernameInput)  usernameInput.placeholder = meta.placeholder;
    if (platformHint)   platformHint.textContent  = meta.hint;
  }

  // Apply defaults for the initially active platform
  applyPlatformMeta(activePlatform);

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activePlatform = chip.dataset.platform;
      applyPlatformMeta(activePlatform);
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
    if (!currentJobId || catboxUploading) return;
    catboxUploading = true;
    try {
      catboxBtn.disabled = true;
      catboxStatus.innerHTML = '<span class="spinner"></span> Uploading to Catbox...';
      
      const res = await fetch(`/api/clipper/clip/${currentJobId}/catbox`, { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${API_KEY}` 
        }
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
        headers: { 
          'Authorization': `Bearer ${API_KEY}` 
        }
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
        headers: {
          'Authorization': `Bearer ${API_KEY}`
        }
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

  // 'reset-btn' doesn't exist in HTML. The two reset buttons are:
  //   #cancel-btn  — in the progress card
  //   #new-clip-btn — in the result card
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
      clipPreview.muted = true;   // required for autoplay on mobile
      clipPreview.load();          // forces load on iOS/Android without a user gesture
      clipPreview.play().catch(() => {}); // show first frame; ignore autoplay rejection
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
    // shield is CSS-only; no JS state to clear
    usernameInput.value = '';
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
    const val = usernameInput.value.trim();
    if (!val) {
      streamPreviewWrap.classList.remove('visible');
      return;
    }

    let embedUrl = '';
    if (activePlatform === 'twitch') {
      // Accept full URL (https://www.twitch.tv/username) or bare username
      let twitchChannel = val;
      try {
        const u = new URL(val);
        if (u.hostname.includes('twitch.tv')) {
          twitchChannel = u.pathname.replace(/^\//, '').split('/')[0];
        }
      } catch (_) {}
      embedUrl = `https://player.twitch.tv/?channel=${twitchChannel}&parent=${window.location.hostname}&muted=true`;
    } else if (activePlatform === 'kick') {
      // Extract slug from full URL if pasted
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