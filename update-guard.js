'use strict';
/* ============================================================
   UPDATE GUARD
   ============================================================
   The admin panel's canary boot test (see admin.js) catches the large
   majority of "bad update" cases — syntax errors, missing files, immediate
   crash-on-boot — *before* anything touches production. This module is the
   second, independent safety net: it catches the smaller set of problems
   that only show up once the new code is actually running live (a runtime
   bug hit by real traffic, a schema-migration issue against the real DB,
   etc.), by watching for a crash *inside the confirmation window right
   after an update was applied* and automatically restoring the pre-update
   files if one happens — no human needs to notice or act.

   How it works:
     1. admin.js calls markUpdateApplied(backupDir) right before it exits
        the process to let PM2/Docker restart it with the new code. This
        writes a small state file recording "an update was just applied,
        here's where its backup lives, treat the next boot as unconfirmed".
     2. On every boot, clipper.js calls checkAndRollbackIfNeeded() as close
        to the top of the file as possible. If the state file says the
        *previous* boot never confirmed success (i.e. the process crashed
        before getting there), this restores every file listed in that
        backup's manifest — synchronously, before the rest of clipper.js's
        risky top-level init (DB open, etc.) runs — so this boot runs the
        last known-good code instead of crashing again.
     3. clipper.js registers uncaughtException/unhandledRejection handlers
        that, if the state is still "pending" (i.e. we're inside the
        confirmation window), immediately roll back and exit — so the
        *next* restart (PM2/Docker) picks up step 2 and boots clean.
     4. Once the app has been alive and listening for CONFIRM_WINDOW_MS,
        clipper.js calls confirmBootSuccess(), which clears the pending
        state — from then on, ordinary crashes are just ordinary crashes,
        not treated as "the last update broke this".
   ============================================================ */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = __dirname;
const STATE_FILE   = path.join(PROJECT_ROOT, '.update-state.json');

// How long a freshly-updated process must stay alive after successfully
// binding to its port before the update is considered confirmed-good.
const CONFIRM_WINDOW_MS = Number(process.env.UPDATE_CONFIRM_WINDOW_MS) || 15_000;

// A freshly-updated process gets exactly one boot attempt to reach
// confirmBootSuccess() on its own. If it doesn't (crashes, hangs, gets
// OOM-killed — anything that skips our uncaughtException handler below),
// the NEXT boot after that treats the update as failed and rolls back
// immediately, rather than retrying forever.
const MAX_BOOT_ATTEMPTS = 1;

// Identifies *this specific process* across the two calls that matter —
// checkAndRollbackIfNeeded() (start of boot) and confirmBootSuccess() (end
// of the confirmation window). This is what stops a stale confirmation
// timer left over from an OLDER process (e.g. the process that was still
// running at the moment an update was applied, before it restarts) from
// firing and wrongly clearing a *different* boot's pending state — that
// older process's timer was scheduled before this update's pending state
// even existed, so it never gets stamped with this bootId and its call
// becomes a harmless no-op.
const BOOT_ID = crypto.randomBytes(8).toString('hex');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[UpdateGuard] Failed to write state file:', err.message);
  }
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* already gone */ }
}

/**
 * Restore every file recorded in a backup's manifest.json back onto its
 * live path. 'modified' entries overwrite the live file with the backed-up
 * copy; 'added' entries (files that did not exist before the update that
 * introduced them) are deleted, since the pre-update state had no such
 * file at all.
 */
function restoreBackup(backupDir) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[UpdateGuard] Cannot read manifest at ${manifestPath}: ${err.message}`);
    return false;
  }

  for (const entry of manifest.files || []) {
    const livePath = path.join(PROJECT_ROOT, entry.path);
    try {
      if (entry.action === 'modified') {
        const backedUpFile = path.join(backupDir, entry.path);
        fs.mkdirSync(path.dirname(livePath), { recursive: true });
        fs.copyFileSync(backedUpFile, livePath);
      } else if (entry.action === 'added') {
        fs.unlinkSync(livePath);
      }
    } catch (err) {
      // Keep going — a best-effort restore of the remaining files is far
      // better than aborting the whole rollback over one missing file.
      console.error(`[UpdateGuard] Failed to restore ${entry.path}: ${err.message}`);
    }
  }
  return true;
}

/**
 * Called at the very top of clipper.js, before any other initialization.
 *
 * If state is 'pending' with no attempt recorded yet, this boot IS the
 * one and only confirming attempt — stamp it with this process's bootId
 * and let it proceed normally. If an attempt was ALREADY recorded (i.e.
 * a previous boot took its one shot and never called confirmBootSuccess —
 * it crashed, hung, or was killed before getting there), give up and
 * restore the backup right now instead of trying again.
 */
function checkAndRollbackIfNeeded() {
  const state = readState();
  if (!state || state.status !== 'pending') return;

  const attempts = (state.attempts || 0) + 1;

  if (attempts > MAX_BOOT_ATTEMPTS) {
    console.error(
      `[UpdateGuard] Update applied at ${state.appliedAt} never confirmed success ` +
      `after ${attempts - 1} boot attempt(s) — rolling back to backup ${state.backupDir}`
    );
    const ok = restoreBackup(state.backupDir);
    writeState({
      ...state,
      status: ok ? 'rolled-back' : 'rollback-failed',
      rolledBackAt: new Date().toISOString(),
      attempts,
    });
    if (ok) console.error('[UpdateGuard] Rollback complete — booting with restored files.');
    else console.error(`[UpdateGuard] Rollback FAILED — manual intervention required. Backup: ${state.backupDir}`);
    return;
  }

  // This boot gets the one confirming attempt.
  writeState({ ...state, attempts, bootId: BOOT_ID });
}

/** Called by admin.js right before it exits to let the process manager restart it. */
function markUpdateApplied(backupDir, stagingId) {
  writeState({
    status: 'pending',
    backupDir,
    stagingId,
    appliedAt: new Date().toISOString(),
    attempts: 0,
  });
}

/**
 * Called once the new process has been alive and serving for
 * CONFIRM_WINDOW_MS. Only clears the pending state if THIS process is the
 * one that was actually stamped as the confirming attempt (see BOOT_ID
 * above) — guards against a stale timer from an older, unrelated process
 * clearing a pending state it was never responsible for.
 */
function confirmBootSuccess() {
  const state = readState();
  if (state && state.status === 'pending' && state.bootId === BOOT_ID) {
    console.log('[UpdateGuard] Update confirmed stable — clearing pending state.');
    clearState();
  }
}

/**
 * Called from uncaughtException / unhandledRejection handlers. If we're
 * still inside an unconfirmed update's boot window, roll back immediately
 * and signal the caller to exit so the process manager restarts us clean.
 * Returns true if a rollback was performed.
 */
function handleFatalError(err) {
  const state = readState();
  if (!state || state.status !== 'pending') return false;

  console.error(
    `[UpdateGuard] Fatal error during unconfirmed update window: ${err && err.message}`
  );
  const ok = restoreBackup(state.backupDir);
  writeState({
    ...state,
    status: ok ? 'rolled-back' : 'rollback-failed',
    rolledBackAt: new Date().toISOString(),
    crashMessage: err && err.message,
  });
  return true;
}

module.exports = {
  CONFIRM_WINDOW_MS,
  checkAndRollbackIfNeeded,
  markUpdateApplied,
  confirmBootSuccess,
  handleFatalError,
};
