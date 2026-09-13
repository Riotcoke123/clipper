(function () {
  let SESSION_TOKEN = sessionStorage.getItem('adminSession') || '';
  let stagingId = null;

  const loginCard   = document.getElementById('login-card');
  const panel       = document.getElementById('panel');
  const loginBtn    = document.getElementById('login-btn');
  const loginPass   = document.getElementById('login-password');
  const loginError  = document.getElementById('login-error');

  const dropZone    = document.getElementById('drop-zone');
  const fileInput   = document.getElementById('file-input');
  const uploadStatus = document.getElementById('upload-status');

  const previewCard = document.getElementById('preview-card');
  const fileList    = document.getElementById('file-list');
  const applyBtn    = document.getElementById('apply-btn');
  const discardBtn  = document.getElementById('discard-btn');
  const applyStatus = document.getElementById('apply-status');

  const historyList = document.getElementById('history-list');

  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalTitle     = document.getElementById('modal-title');
  const modalDesc       = document.getElementById('modal-desc');
  const modalPassword    = document.getElementById('modal-password');
  const modalConfirm       = document.getElementById('modal-confirm');
  const modalCancel         = document.getElementById('modal-cancel');
  const modalError         = document.getElementById('modal-error');

  function authHeaders(extra) {
    return Object.assign({ 'Authorization': `Session ${SESSION_TOKEN}` }, extra || {});
  }

  function showPanel() {
    loginCard.style.display = 'none';
    panel.style.display = '';
    loadHistory();
  }

  if (SESSION_TOKEN) showPanel();

  loginBtn.addEventListener('click', async () => {
    loginError.textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPass.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      SESSION_TOKEN = data.sessionToken;
      sessionStorage.setItem('adminSession', SESSION_TOKEN);
      loginPass.value = '';
      showPanel();
    } catch (err) {
      loginError.textContent = err.message;
    }
  });

  /* ── Upload ── */
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });

  async function uploadFile(file) {
    uploadStatus.className = 'msg';
    uploadStatus.textContent = 'Uploading and validating…';
    const form = new FormData();
    form.append('package', file);
    try {
      const res = await fetch('/api/admin/update/upload', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      stagingId = data.stagingId;
      renderFileList(data.files);
      uploadStatus.className = 'msg ok';
      uploadStatus.textContent = `Validated ${data.files.length} file(s).`;
      previewCard.style.display = '';
      applyStatus.textContent = '';
    } catch (err) {
      uploadStatus.className = 'msg error';
      uploadStatus.textContent = err.message;
    }
    fileInput.value = '';
  }

  function renderFileList(files) {
    fileList.innerHTML = '';
    files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'file-row';
      const name = document.createElement('span');
      name.textContent = f.path;
      const action = document.createElement('span');
      action.className = 'action ' + f.action;
      action.textContent = f.action;
      row.appendChild(name);
      row.appendChild(action);
      fileList.appendChild(row);
    });
  }

  discardBtn.addEventListener('click', async () => {
    if (!stagingId) return;
    await fetch('/api/admin/update/discard', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ stagingId }),
    });
    stagingId = null;
    previewCard.style.display = 'none';
    uploadStatus.textContent = '';
  });

  applyBtn.addEventListener('click', () => {
    if (!stagingId) return;
    openPasswordModal({
      title: 'Apply update',
      desc: 'This will run a pre-flight boot test, back up the current files, then apply and restart the site. Re-enter your admin password to confirm.',
      onConfirm: async (password) => {
        applyStatus.className = 'msg';
        applyStatus.textContent = 'Running pre-flight boot test…';
        const res = await fetch('/api/admin/update/apply', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ stagingId, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          applyStatus.className = 'msg error';
          applyStatus.textContent = data.detail ? `${data.error}\n\n${data.detail}` : data.error;
          throw new Error(data.error || 'Apply failed');
        }
        applyStatus.className = 'msg ok';
        applyStatus.textContent = data.message + ' The page will stop responding for a few seconds while it restarts.';
        stagingId = null;
        previewCard.style.display = 'none';
        setTimeout(loadHistory, 5000);
      },
    });
  });

  /* ── History ── */
  async function loadHistory() {
    try {
      const res = await fetch('/api/admin/update/history', { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load history');
      renderHistory(data.backups);
    } catch (err) {
      historyList.textContent = err.message;
    }
  }

  function renderHistory(backups) {
    historyList.innerHTML = '';
    if (backups.length === 0) {
      historyList.innerHTML = '<span style="opacity:0.6">No updates applied yet.</span>';
      return;
    }
    backups.forEach(b => {
      const row = document.createElement('div');
      row.className = 'hist-row';
      const label = document.createElement('span');
      label.textContent = `${b.timestamp} — ${b.fileCount} file(s)`;
      const rollbackBtn = document.createElement('button');
      rollbackBtn.className = 'btn danger';
      rollbackBtn.textContent = 'Rollback to this';
      rollbackBtn.addEventListener('click', () => {
        openPasswordModal({
          title: 'Rollback',
          desc: `Restore the ${b.fileCount} file(s) from this backup and restart the site.`,
          onConfirm: async (password) => {
            const res = await fetch('/api/admin/update/rollback', {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ backupId: b.id, password }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Rollback failed');
            setTimeout(loadHistory, 5000);
          },
        });
      });
      row.appendChild(label);
      row.appendChild(rollbackBtn);
      historyList.appendChild(row);
    });
  }

  /* ── Password confirmation modal (shared by Apply and Rollback) ── */
  function openPasswordModal({ title, desc, onConfirm }) {
    modalTitle.textContent = title;
    modalDesc.textContent = desc;
    modalPassword.value = '';
    modalError.textContent = '';
    modalBackdrop.classList.add('open');
    modalPassword.focus();

    function cleanup() {
      modalBackdrop.classList.remove('open');
      modalConfirm.removeEventListener('click', onConfirmClick);
      modalCancel.removeEventListener('click', onCancelClick);
    }
    async function onConfirmClick() {
      modalError.textContent = '';
      modalConfirm.disabled = true;
      try {
        await onConfirm(modalPassword.value);
        cleanup();
      } catch (err) {
        modalError.textContent = err.message;
      } finally {
        modalConfirm.disabled = false;
      }
    }
    function onCancelClick() { cleanup(); }

    modalConfirm.addEventListener('click', onConfirmClick);
    modalCancel.addEventListener('click', onCancelClick);
  }
})();
