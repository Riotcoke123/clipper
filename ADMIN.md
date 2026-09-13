# Admin Panel — Setup & Usage

The admin panel lives at `/admin` and lets you deploy code updates to the
live site from a browser, with a pre-flight safety check and automatic
rollback if something goes wrong. This doc covers first-time setup and how
to actually use it.

## 1. First-time setup

Set a dedicated admin password in your `.env` (do **not** reuse
`CLIPPER_API_KEY`):

```
ADMIN_PASSWORD=choose-something-long-and-random-at-least-12-chars
```

The server refuses to start without this set (same fail-fast pattern as
`CLIPPER_API_KEY`).

If you're running behind Nginx per `deploy.sh`, also lock `/admin` and
`/api/admin/*` down to your own IP at the edge — see
`clipper.iceposeidon.network.conf`, which restricts those paths to an IP
allowlist in addition to the app's own password. Edit the placeholder IP
in that file before your first deploy:

```nginx
location ~ ^/(admin|api/admin) {
    allow 203.0.113.10;   # ← your real IP goes here
    deny all;
    ...
}
```

Restart (or, after this update, use the panel itself for future code
changes — see the note in the main response about the Docker volume
setup if you're using `docker-compose.yml`).

## 2. Logging in

Go to `https://your-domain/admin` and enter `ADMIN_PASSWORD`. This gives
you a session (1 hour TTL) for browsing the panel — it does **not** by
itself let you apply an update; see step 4.

Failed login attempts are rate-limited (8 per 15 minutes per IP by
default — `ADMIN_LOGIN_MAX_ATTEMPTS`).

## 3. Building an update package

Any zip works, as long as the files inside it are laid out relative to
the project root (a single wrapper folder, like GitHub's "Download ZIP"
produces, is automatically detected and stripped). Two kinds of packages
work identically:

- **Full package** — the whole project. Everything present gets checked;
  files *not* present are left untouched (nothing gets deleted).
- **Changed-files-only package** — just the files that changed this
  round. This is what you'll get by default from this point forward
  (see the note about that in the main conversation).

A handful of things can never be included in an update package, no
matter what: `.env`, `node_modules/`, `.git/`, the SQLite DB files, and
the runtime data directories (`public/clips`, `temp`, `logs`, `backups`,
`.staging`). If your zip contains any of these, the upload is rejected
outright with a clear error naming the offending path.

## 4. Uploading, previewing, and applying

1. **Drop the zip** onto the panel. It's validated immediately — zip-slip
   protection, file-type allowlist, size caps, and a `node --check`
   syntax pass on every `.js` file. If anything fails, you get an error
   immediately and nothing is staged.
2. **Review the preview** — you'll see exactly which files are `added`
   vs `modified` before committing to anything.
3. **Click Apply** — you'll be asked to **re-enter your admin password**.
   This is deliberate: being logged into the panel isn't enough to push
   to production; the password confirms this specific, consequential
   action. Behind the scenes, this then:
   - builds an isolated copy of the app with your changes overlaid,
   - boots it on a scratch port against a scratch database,
   - only proceeds to touch the live site if that boots and responds
     successfully — if it doesn't, you get the failure output back and
     **nothing about the live site changes**,
   - backs up every file it's about to touch,
   - applies the files, and restarts the process.

## 5. If something goes wrong after applying

The pre-flight boot test catches the overwhelming majority of "this
update breaks the site" cases (syntax errors, missing files, immediate
crash-on-boot) *before* anything is applied. For the smaller class of
issues that only show up under real production conditions (e.g. a bug
that only triggers against your actual database), there's a second,
independent safety net: if the freshly-applied code crashes before
staying alive for 15 seconds, **the very next restart automatically
restores the pre-update files** — you don't need to notice or do
anything.

For anything else — the update "works" but you want to undo it anyway —
use **Rollback** in the Update History section of the panel. Pick the
backup, re-enter your password, confirm. Same password step-up as Apply.

## 6. Where backups live

Every applied update leaves a timestamped folder under `backups/` with
the pre-update copies of whatever it changed, plus a `manifest.json`
describing what was touched. The 15 most recent are kept
(`ADMIN_BACKUP_RETENTION`); older ones are pruned automatically.

## Environment variables reference

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | *(required)* | Gates the panel and the apply/rollback confirmation |
| `ADMIN_UPDATE_MAX_MB` | 50 | Total update package size cap |
| `ADMIN_UPDATE_MAX_FILE_MB` | 15 | Per-file size cap within a package |
| `ADMIN_BACKUP_RETENTION` | 15 | How many past-update backups to keep |
| `ADMIN_CANARY_PORT` | 4299 | Scratch port for the pre-apply boot test |
| `ADMIN_CANARY_TIMEOUT_MS` | 15000 | How long the boot test waits before giving up |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | 8 | Admin password attempts per 15 min per IP |
| `UPDATE_CONFIRM_WINDOW_MS` | 15000 | How long a freshly-updated process must stay up to be considered confirmed |
| `TRUST_PROXY` | 1 | Reverse-proxy hops to trust for real client IP (needed for correct rate limiting behind Nginx) |
