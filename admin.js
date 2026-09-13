'use strict';
/* ============================================================
   ADMIN PANEL — self-update system
   ============================================================
   Lets you upload a zip (either a full project package or a "changed
   files only" package — both work identically, since this just applies
   whatever files ARE in the zip and leaves everything else untouched)
   and apply it to the live site from the browser, without SSH.

   Safety model, in order:
     1. Upload  → the zip is validated and extracted to a private staging
        directory. Nothing live is touched yet. Zip-slip, file-type, and
        size checks happen here; any .js file is syntax-checked with
        `node --check`.
     2. Preview → you get back exactly which files will be added/changed,
        so you can see what you're about to ship before committing.
     3. Apply   → requires re-entering your admin password (a deliberate
        "are you sure" step separate from just being logged into the
        panel). We then:
          a. Build a full throwaway copy of the live project ("candidate")
             with the staged files overlaid on top, pointed at scratch
             DB/clip directories and a scratch port.
          b. Boot that candidate as a real child process and health-check
             it. If it fails to boot or doesn't respond, we stop here —
             nothing about the live site has changed.
          c. Only if the candidate boots clean: back up every live file
             about to be touched, copy the staged files into place, write
             an update-state marker (see update-guard.js), and exit — the
             process manager (PM2 / `restart: unless-stopped` in Docker)
             restarts us with the new code.
          d. If the new live process then crashes before confirming it's
             healthy, update-guard.js automatically restores the backup
             on the very next boot — no human needs to notice.
     4. Rollback → a manual "restore this specific backup" action for
        anything that isn't caught automatically (e.g. the update *works*
        but you decide afterwards you don't want it).

   Excluded from every update, no matter what's in the zip: `.env` (never
   let an update silently rewrite your secrets), `node_modules/`, `.git/`,
   the SQLite DB files, and the runtime data directories (`public/clips`,
   `temp`, `logs`, `backups`, `.staging`). The update mechanism only ever
   touches source/deployment files.
   ============================================================ */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const multer  = require('multer');
const AdmZip  = require('adm-zip');
const fetch   = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const updateGuard = require('./update-guard');

const PROJECT_ROOT = __dirname;
const STAGING_DIR  = path.join(PROJECT_ROOT, '.staging');
const BACKUPS_DIR  = path.join(PROJECT_ROOT, 'backups');

/* ── Config ───────────────────────────────────────────────── */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error(
    '[Admin] FATAL: ADMIN_PASSWORD must be set to a string of at least 12 characters.\n' +
    '        This gates the admin panel that can write files onto the live server —\n' +
    '        do not reuse CLIPPER_API_KEY for it, and do not skip this.'
  );
  process.exit(1);
}

const ADMIN_SESSION_TTL_MS   = 60 * 60_000; // 1 hour
const UPDATE_MAX_BYTES       = (Number(process.env.ADMIN_UPDATE_MAX_MB) || 50) * 1024 * 1024;
const MAX_FILE_BYTES         = (Number(process.env.ADMIN_UPDATE_MAX_FILE_MB) || 15) * 1024 * 1024;
const BACKUP_RETENTION       = Number(process.env.ADMIN_BACKUP_RETENTION) || 15;
const STAGING_TTL_MS         = 30 * 60_000; // abandoned uploads expire after 30 min
const CANARY_PORT            = Number(process.env.ADMIN_CANARY_PORT) || 4299;
const CANARY_BOOT_TIMEOUT_MS = Number(process.env.ADMIN_CANARY_TIMEOUT_MS) || 15_000;

// File extensions an update is allowed to touch. Deliberately excludes
// anything that isn't source/deployment code.
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.html', '.css', '.json',
  '.md', '.sh', '.yml', '.yaml', '.txt',
]);

// Paths (relative to project root, POSIX-style) an update must never touch,
// even if a file with an allowed extension shows up at that path.
const EXCLUDED_PREFIXES = [
  '.env', '.git/', 'node_modules/', 'public/clips/', 'temp/',
  'logs/', 'backups/', '.staging/', '.update-state.json', 'clipper.db',
];

function isExcludedPath(relPath) {
  const norm = relPath.split(path.sep).join('/');
  return EXCLUDED_PREFIXES.some(p => norm === p || norm.startsWith(p));
}

/* ── Constant-time password check (mirrors clipper.js's safeCompare) ── */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ── Admin session store (separate from the clip-capture sessions) ── */
const _adminSessions = new Map(); // token → expiresAt
function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  _adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}
function isValidAdminSession(token) {
  if (!token) return false;
  const exp = _adminSessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { _adminSessions.delete(token); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of _adminSessions) if (now > exp) _adminSessions.delete(t);
}, 5 * 60_000).unref();

function requireAdminSession(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Session ') ? header.slice(8).trim() : '';
  if (isValidAdminSession(token)) return next();
  return res.status(401).json({ error: 'Admin session required — please log in again' });
}

/* ── Rate limiting for password checks (login + the apply/rollback
   step-up confirmation) — this is the panel's most brute-forceable
   surface, so it gets its own strict, dedicated limiter. ── */
const _loginAttempts = new Map(); // ip → { count, resetAt }
function passwordRateLimit(req, res, next) {
  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const WINDOW = 15 * 60_000;
  const MAX    = Number(process.env.ADMIN_LOGIN_MAX_ATTEMPTS) || 8;
  let bucket = _loginAttempts.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW };
    _loginAttempts.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > MAX) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many attempts — try again later' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of _loginAttempts) if (now > b.resetAt) _loginAttempts.delete(k);
}, 5 * 60_000).unref();

/* ── In-memory registry of staged (uploaded, validated, not-yet-applied)
   updates. Each staged upload lives in its own directory under
   .staging/<id>/ so multiple can exist without colliding. ── */
const _pending = new Map(); // stagingId → { dir, files, createdAt }
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _pending) {
    if (now - entry.createdAt > STAGING_TTL_MS) {
      fs.rm(entry.dir, { recursive: true, force: true }, () => {});
      _pending.delete(id);
    }
  }
}, 5 * 60_000).unref();

/* ── Recursively copy a directory, skipping any of a given set of
   top-level relative names (used to build the candidate directory
   without copying node_modules / runtime-data dirs). ── */
function copyProjectTree(srcRoot, destRoot, skipTopLevel) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (skipTopLevel.has(entry.name)) continue;
    const src  = path.join(srcRoot, entry.name);
    const dest = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Extract + validate an uploaded zip into a fresh staging directory.
 * Throws on any validation failure (caller turns that into a 400).
 * Returns { files: [{ path, action, size }] } — action is 'added' or
 * 'modified' depending on whether a live file already exists at that path.
 */
function stageUpload(zipBuffer, stagingDir) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw Object.assign(new Error(`Not a valid zip file: ${err.message}`), { status: 400 });
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw Object.assign(new Error('Zip file is empty'), { status: 400 });
  }

  let totalBytes = 0;
  const staged = [];

  fs.mkdirSync(stagingDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Normalize away a possible single top-level wrapper folder (e.g. the
    // zip contains "clipper-main/clipper.js" rather than "clipper.js") so
    // packages built either way work the same.
    let relPath = entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    const firstSlash = relPath.indexOf('/');
    // We can't know the wrapper-folder name in advance, so we detect it
    // structurally below once we've seen all entries — for now keep the
    // raw relative path and strip later if every entry shares one prefix.
    staged.push({ raw: entry, relPath });
  }

  // Detect a common single top-level directory shared by every entry, and
  // strip it — this is what "download ZIP" from GitHub / this app's own
  // "full package" export both produce.
  const topDirs = new Set(staged.map(s => s.relPath.split('/')[0]));
  let stripPrefix = '';
  if (topDirs.size === 1) {
    const only = [...topDirs][0];
    if (staged.every(s => s.relPath.startsWith(only + '/'))) stripPrefix = only + '/';
  }

  const result = [];
  for (const { raw: entry, relPath: originalRel } of staged) {
    const relPath = stripPrefix ? originalRel.slice(stripPrefix.length) : originalRel;
    if (!relPath) continue;

    // ── Zip-slip guard ──
    // Reject absolute paths, drive letters, and any ".." component BEFORE
    // ever resolving to a real filesystem path — belt and suspenders
    // alongside the resolved-path check below.
    if (path.isAbsolute(relPath) || relPath.split('/').includes('..')) {
      throw Object.assign(new Error(`Unsafe path in zip: ${relPath}`), { status: 400 });
    }
    const destPath = path.join(stagingDir, relPath);
    if (!destPath.startsWith(stagingDir + path.sep) && destPath !== stagingDir) {
      throw Object.assign(new Error(`Unsafe path in zip: ${relPath}`), { status: 400 });
    }

    // ── Never allow an update to touch secrets or runtime data ──
    if (isExcludedPath(relPath)) {
      throw Object.assign(
        new Error(`Update package must not include protected path: ${relPath}`),
        { status: 400 }
      );
    }

    // ── Extension allowlist ──
    const ext = path.extname(relPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw Object.assign(
        new Error(`File type not allowed in an update: ${relPath}`),
        { status: 400 }
      );
    }

    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) {
      throw Object.assign(
        new Error(`${relPath} exceeds the ${MAX_FILE_BYTES / 1048576}MB per-file limit`),
        { status: 400 }
      );
    }
    totalBytes += data.length;
    if (totalBytes > UPDATE_MAX_BYTES) {
      throw Object.assign(
        new Error(`Update package exceeds the ${UPDATE_MAX_BYTES / 1048576}MB total limit`),
        { status: 400 }
      );
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, data);

    const livePath = path.join(PROJECT_ROOT, relPath);
    result.push({
      path: relPath,
      action: fs.existsSync(livePath) ? 'modified' : 'added',
      size: data.length,
    });
  }

  if (result.length === 0) {
    throw Object.assign(new Error('No updatable files found in zip'), { status: 400 });
  }

  // ── Syntax-check every staged JS file before anything else happens.
  // This alone catches the single most common "bad update" case for free.
  for (const file of result) {
    if (path.extname(file.path) === '.js' || path.extname(file.path) === '.cjs') {
      const r = require('child_process').spawnSync(
        process.execPath, ['--check', path.join(stagingDir, file.path)],
        { encoding: 'utf8' }
      );
      if (r.status !== 0) {
        throw Object.assign(
          new Error(`Syntax error in ${file.path}:\n${(r.stderr || '').slice(0, 1000)}`),
          { status: 400 }
        );
      }
    }
  }

  return result;
}

/**
 * Build a throwaway "candidate" copy of the live project with the staged
 * files overlaid, and boot it as a real child process pointed at scratch
 * DB/clip/temp directories and a scratch port, to verify it actually
 * starts and serves before we touch anything live.
 * Resolves { ok: true } or { ok: false, log } — never throws.
 */
async function canaryBootTest(stagingDir, stagedFiles) {
  const candidateDir = path.join(STAGING_DIR, `candidate-${Date.now()}`);
  try {
    copyProjectTree(PROJECT_ROOT, candidateDir, new Set([
      'node_modules', '.git', 'public', 'temp', 'logs', 'backups', '.staging',
      'clipper.db', 'clipper.db-wal', 'clipper.db-shm', '.env', '.update-state.json',
    ]));
    // public/ needs its own copy too (it's excluded above only to skip its
    // clips/ subfolder, which can be large/irrelevant to the boot test).
    fs.mkdirSync(path.join(candidateDir, 'public'), { recursive: true });
    for (const entry of fs.readdirSync(path.join(PROJECT_ROOT, 'public'), { withFileTypes: true })) {
      if (entry.name === 'clips') continue;
      const src = path.join(PROJECT_ROOT, 'public', entry.name);
      const dest = path.join(candidateDir, 'public', entry.name);
      if (entry.isDirectory()) fs.cpSync(src, dest, { recursive: true });
      else fs.copyFileSync(src, dest);
    }

    // Overlay the staged (changed) files on top of the live snapshot.
    for (const file of stagedFiles) {
      const src  = path.join(stagingDir, file.path);
      const dest = path.join(candidateDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    // Reuse the live node_modules via symlink rather than copying it.
    fs.symlinkSync(
      path.join(PROJECT_ROOT, 'node_modules'),
      path.join(candidateDir, 'node_modules'),
      'dir'
    );

    fs.mkdirSync(path.join(candidateDir, 'public', 'clips'), { recursive: true });
    fs.mkdirSync(path.join(candidateDir, 'temp'), { recursive: true });

    const env = {
      ...process.env,
      PORT: String(CANARY_PORT),
      DB_PATH: path.join(candidateDir, 'canary.db'),
      CLIP_OUTPUT_DIR: path.join(candidateDir, 'public', 'clips'),
      CLIP_TEMP_DIR: path.join(candidateDir, 'temp'),
    };

    let child;
    let stderrLog = '';
    const bootResult = await new Promise((resolve) => {
      child = spawn(process.execPath, ['clipper.js'], { cwd: candidateDir, env });
      let settled = false;
      child.stderr.on('data', d => { stderrLog += d.toString(); });
      child.on('exit', (code) => {
        if (!settled) { settled = true; resolve({ ok: false, log: `Process exited early (code ${code}):\n${stderrLog.slice(-2000)}` }); }
      });
      child.on('error', (err) => {
        if (!settled) { settled = true; resolve({ ok: false, log: `Failed to spawn: ${err.message}` }); }
      });

      const deadline = Date.now() + CANARY_BOOT_TIMEOUT_MS;
      (async function poll() {
        while (Date.now() < deadline && !settled) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const res = await fetch(`http://127.0.0.1:${CANARY_PORT}/`, { timeout: 2000 });
            if (res.ok || res.status === 404) {
              if (!settled) { settled = true; resolve({ ok: true }); }
              return;
            }
          } catch (_) { /* not up yet — keep polling */ }
        }
        if (!settled) { settled = true; resolve({ ok: false, log: `Did not respond within ${CANARY_BOOT_TIMEOUT_MS / 1000}s:\n${stderrLog.slice(-2000)}` }); }
      })();
    });

    if (child) { try { child.kill('SIGKILL'); } catch (_) {} }
    return bootResult;
  } catch (err) {
    return { ok: false, log: `Candidate build failed: ${err.message}` };
  } finally {
    fs.rm(candidateDir, { recursive: true, force: true }, () => {});
  }
}

/** Back up every live file a staged update is about to touch, and return the backup dir. */
function backupBeforeApply(stagingDir, stagedFiles) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUPS_DIR, timestamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const manifestFiles = [];
  for (const file of stagedFiles) {
    const livePath = path.join(PROJECT_ROOT, file.path);
    if (file.action === 'modified') {
      const backupPath = path.join(backupDir, file.path);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(livePath, backupPath);
    }
    manifestFiles.push({ path: file.path, action: file.action });
  }

  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify({ timestamp, files: manifestFiles }, null, 2)
  );

  pruneOldBackups();
  return backupDir;
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const dirs = fs.readdirSync(BACKUPS_DIR)
    .filter(n => fs.statSync(path.join(BACKUPS_DIR, n)).isDirectory())
    .sort(); // ISO timestamps sort chronologically as strings
  while (dirs.length > BACKUP_RETENTION) {
    const oldest = dirs.shift();
    fs.rmSync(path.join(BACKUPS_DIR, oldest), { recursive: true, force: true });
  }
}

function applyStagedFiles(stagingDir, stagedFiles) {
  for (const file of stagedFiles) {
    const src  = path.join(stagingDir, file.path);
    const dest = path.join(PROJECT_ROOT, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/* ============================================================
   ROUTER
   ============================================================ */
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPDATE_MAX_BYTES } });

router.post('/login', passwordRateLimit, (req, res) => {
  const { password } = req.body || {};
  if (!safeCompare(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ sessionToken: createAdminSession() });
});

router.post('/logout', requireAdminSession, (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Session ') ? header.slice(8).trim() : '';
  _adminSessions.delete(token);
  res.json({ ok: true });
});

router.get('/update/history', requireAdminSession, (req, res) => {
  if (!fs.existsSync(BACKUPS_DIR)) return res.json({ backups: [] });
  const backups = fs.readdirSync(BACKUPS_DIR)
    .filter(n => fs.statSync(path.join(BACKUPS_DIR, n)).isDirectory())
    .sort().reverse()
    .map(id => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, id, 'manifest.json'), 'utf8'));
        return { id, timestamp: manifest.timestamp, fileCount: manifest.files.length };
      } catch (_) { return { id, timestamp: id, fileCount: 0 }; }
    });
  res.json({ backups });
});

router.post('/update/upload', requireAdminSession, upload.single('package'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "package")' });

  const stagingId  = crypto.randomBytes(16).toString('hex');
  const stagingDir = path.join(STAGING_DIR, stagingId);

  try {
    const files = stageUpload(req.file.buffer, stagingDir);
    _pending.set(stagingId, { dir: stagingDir, files, createdAt: Date.now() });
    res.json({ stagingId, files });
  } catch (err) {
    fs.rm(stagingDir, { recursive: true, force: true }, () => {});
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/update/discard', requireAdminSession, (req, res) => {
  const { stagingId } = req.body || {};
  const entry = _pending.get(stagingId);
  if (!entry) return res.status(404).json({ error: 'Staged update not found (it may have expired)' });
  fs.rm(entry.dir, { recursive: true, force: true }, () => {});
  _pending.delete(stagingId);
  res.json({ ok: true });
});

router.post('/update/apply', requireAdminSession, passwordRateLimit, async (req, res) => {
  const { stagingId, password } = req.body || {};

  // Step-up confirmation: being logged into the panel is not enough to
  // push to production — the password must be re-entered for this
  // specific, irreversible-without-rollback action.
  if (!safeCompare(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const entry = _pending.get(stagingId);
  if (!entry) return res.status(404).json({ error: 'Staged update not found (it may have expired) — upload it again' });

  console.log(`[Admin] Applying update ${stagingId} (${entry.files.length} file(s)) — running canary boot test...`);
  const canary = await canaryBootTest(entry.dir, entry.files);
  if (!canary.ok) {
    console.error(`[Admin] Canary boot test FAILED for ${stagingId} — nothing was applied.\n${canary.log}`);
    return res.status(422).json({
      error: 'The update failed a pre-flight boot test and was NOT applied. The live site is untouched.',
      detail: canary.log,
    });
  }
  console.log(`[Admin] Canary boot test passed for ${stagingId} — applying to production.`);

  let backupDir;
  try {
    backupDir = backupBeforeApply(entry.dir, entry.files);
    applyStagedFiles(entry.dir, entry.files);
  } catch (err) {
    console.error(`[Admin] Apply failed for ${stagingId}:`, err.message);
    return res.status(500).json({ error: `Failed while applying files: ${err.message}` });
  }

  // Clean up the staging upload now that it's been applied.
  fs.rm(entry.dir, { recursive: true, force: true }, () => {});
  _pending.delete(stagingId);

  // Mark the update as pending confirmation, then restart. If the new
  // code crashes before confirming healthy, update-guard.js restores
  // `backupDir` automatically on the next boot.
  updateGuard.markUpdateApplied(backupDir, stagingId);

  res.json({
    ok: true,
    message: `Applied ${entry.files.length} file(s). Backup saved. Restarting to load the new code...`,
    backupId: path.basename(backupDir),
  });

  console.log(`[Admin] Update ${stagingId} applied — restarting for the process manager to pick up new code.`);
  setTimeout(() => process.exit(0), 1500);
});

router.post('/update/rollback', requireAdminSession, passwordRateLimit, (req, res) => {
  const { backupId, password } = req.body || {};
  if (!safeCompare(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const backupDir = path.join(BACKUPS_DIR, backupId || '');
  if (!backupId || backupId.includes('..') || !fs.existsSync(path.join(backupDir, 'manifest.json'))) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) {
    const livePath = path.join(PROJECT_ROOT, file.path);
    try {
      if (file.action === 'modified') {
        fs.mkdirSync(path.dirname(livePath), { recursive: true });
        fs.copyFileSync(path.join(backupDir, file.path), livePath);
      } else if (file.action === 'added') {
        fs.rm(livePath, { force: true }, () => {});
      }
    } catch (err) {
      console.error(`[Admin] Rollback: failed to restore ${file.path}: ${err.message}`);
    }
  }

  res.json({ ok: true, message: `Restored ${manifest.files.length} file(s). Restarting...` });
  console.log(`[Admin] Manual rollback to ${backupId} applied — restarting.`);
  setTimeout(() => process.exit(0), 1500);
});

module.exports = { router };
