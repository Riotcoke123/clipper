<div align="center">

# 🎬 Stream Clipper v1.5

**Multi-platform live stream clipper for YouTube, Twitch, and Kick — with a self-updating admin panel.**

<p>
  <img src="https://img.shields.io/badge/version-1.5-blue.svg?style=flat-square" alt="Version 1.5">
  <img src="https://img.shields.io/badge/license-GPL--3.0-brightgreen.svg?style=flat-square" alt="GPL License">
  <img src="https://img.shields.io/badge/Node.js-20-43853D?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20">
  <img src="https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="FFmpeg">
  <img src="https://img.shields.io/badge/SQLite-074A5F?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/PM2-2B037A?style=flat-square&logo=pm2&logoColor=white" alt="PM2">
  <img src="https://img.shields.io/badge/Nginx-009639?style=flat-square&logo=nginx&logoColor=white" alt="Nginx">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
</p>

<sub>Live at <a href="https://clipper.iceposeidon.network/">clipper.iceposeidon.network</a></sub>

</div>

---

## Overview

Stream Clipper is a multi-platform live stream clipper tool designed to capture
video segments from YouTube, Twitch, and Kick. It allows users to set specific
durations, pick video qualities, and generate downloadable MP4s directly from
a live stream. It also supports direct one-click server-side proxy uploads to
file-hosting services like Catbox, qu.ax, and Videy — and ships with a
password-gated admin panel for deploying code updates to the live server
without SSH, complete with a pre-flight safety check and automatic rollback.

## Features

- **Multi-Platform Support** — Extract clips from YouTube, Twitch, and Kick live streams.
- **DVR Rewind** — A rewind slider lets you capture moments from earlier in the stream (up to 120s via the UI, 300s on the backend), seeking directly into the HLS DVR buffer.
- **Advanced YouTube Extraction** — Uses `yt-dlp` against YouTube's Android `player_client` innertube API, bypassing PO Token requirements on VPS/datacenter IPs.
- **Direct HLS Capture** — Twitch/Kick streams are pre-resolved to direct HLS URLs and piped straight into native FFmpeg for reliable live-edge clipping.
- **Direct Uploads** — One-click server-side proxy uploads to Catbox, qu.ax, or Videy.
- **Live Previews** — Embedded iframe preview before clipping.
- **Automated Cleanup** — Stale clips and temp files are purged every 30 minutes.
- **Database Analytics** — SQLite in WAL mode tracks clip counts, unique users, and stream durations.
- **Hardened by default** — Timing-safe key comparisons, per-IP rate limiting (correctly configured behind a reverse proxy), a locked-down CSP/security-header set, and a session-token model that keeps the master API key off the browser entirely. See [Security](#security) below.
- **🆕 Self-update admin panel** — Deploy code changes from a browser at `/admin`: upload a zip, get a preview of exactly what will change, and apply it behind a password-confirmed, canary-tested, auto-backed-up, auto-rollback-on-failure pipeline. See [Admin Panel](#admin-panel--self-updates) below and the full guide in [`ADMIN.md`](./ADMIN.md).

## Prerequisites

If setting this up manually/natively, ensure your system has:

- Node.js v18+ (Node 20 LTS recommended)
- `yt-dlp` (latest version)
- FFmpeg
- SQLite3
- *Or simply use Docker (see below).*

## Docker Deployment (Recommended)

1. Make sure **Docker** and **Docker Compose** are installed.
2. Clone the repository and copy the example environment file:
   ```
   cp .env.example .env
   ```
3. Configure `.env` with your API keys, a secure `CLIPPER_API_KEY`, and a
   dedicated `ADMIN_PASSWORD` for the admin panel (see
   [Environment Variables](#environment-variables) — **do not** reuse
   `CLIPPER_API_KEY` as your admin password).
4. Build and start the container:
   ```
   docker compose up -d --build
   ```

### Docker Architecture Notes

- **Persistent Volumes** — Named volumes for the SQLite database, generated
  clips, temp files, and logs so nothing is lost on rebuild. Note: because
  the DB volume mounts the whole `/app` directory, a plain
  `docker compose up --build` after your first deploy won't pick up local
  source edits — the volume shadows the image. Use the admin panel (or
  `docker compose down -v` for a clean-slate rebuild, which also wipes your
  DB/clips/backups) to ship code changes going forward.
- **Runs as non-root** — The container drops to an unprivileged `clipper`
  user at startup via a small entrypoint script, after fixing volume
  ownership. Combined with `cap_drop: ALL` (plus the minimal `SETUID` /
  `SETGID` / `CHOWN` capabilities that drop actually requires), the app
  process itself never runs as root.
- **Resource Limits** — Capped at 1GB memory / 2 CPU cores so FFmpeg can't
  starve the host.
- **Networking** — Exposed only on `127.0.0.1:4242`; put Nginx (or another
  reverse proxy) in front for HTTPS. See `clipper.iceposeidon.network.conf`
  for a full example, including IP-restricting the admin panel.

## Automated Deployment (Ubuntu/Debian)

```
chmod +x deploy.sh
sudo ./deploy.sh
```

Provisions Nginx, Let's Encrypt (Certbot), PM2, FFmpeg, Node.js 20, and
`yt-dlp` from scratch. Optionally lock down SSH/firewall/fail2ban:

```
chmod +x harden.sh
sudo ./harden.sh
```

## Admin Panel & Self-Updates

Available at `/admin` once `ADMIN_PASSWORD` is set. Lets you push code
updates to the live site from a browser — no SSH required — via:

1. **Upload** a zip (either the full project or just the changed files —
   both work the same way). It's validated immediately: zip-slip
   protection, a file-type allowlist, size caps, and a syntax check on
   every `.js` file. Secrets (`.env`), `node_modules/`, the database, and
   runtime-data directories can never be touched by an update.
2. **Preview** exactly which files will be added or modified.
3. **Apply** — requires re-entering your admin password as a deliberate
   confirmation step. Behind the scenes this builds an isolated copy of
   the app with your changes, boots it against a scratch database on a
   scratch port, and only touches the live site if that boot test passes.
   Every file about to change is backed up first.
4. **Automatic rollback** — if the newly-applied code crashes before
   staying alive for 15 seconds, the very next restart automatically
   restores the pre-update files. A manual **Rollback** button (also
   password-confirmed) is available in the Update History section for
   anything outside that window.

Full setup and usage walkthrough: **[`ADMIN.md`](./ADMIN.md)**.

## Security

A quick summary of what's hardened by default — details in the code
comments and [`ADMIN.md`](./ADMIN.md):

- Timing-safe comparisons (`crypto.timingSafeEqual`) for all API keys,
  session checks, and the admin password — no `===` on secrets.
- Per-IP rate limiting on clip creation, polling, login, and the admin
  panel, correctly scoped behind a reverse proxy via `trust proxy`.
- CSP, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`
  set on every response.
- SSRF allowlisting on user-supplied stream URLs.
- The browser never sees the real `CLIPPER_API_KEY` — only short-lived
  session tokens issued by `/login`.
- The container runs as a non-root user.

Found something? Please open an issue rather than a public PR with exploit
details.

## Environment Variables

Set these in `.env`:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | | 4242 | Port the app listens on |
| `CLIPPER_API_KEY` | ✅ | | Admin-level API key, 32+ chars |
| `CLIPPER_BROWSER_KEY` | | = `CLIPPER_API_KEY` | Optional separate browser-facing key |
| `ADMIN_PASSWORD` | ✅ | | Gates `/admin` — 12+ chars, keep separate from `CLIPPER_API_KEY` |
| `TRUST_PROXY` | | 1 | Reverse-proxy hops to trust for real client IP |
| `MAX_CLIP_SECONDS` | | 300 | Max duration for a single clip |
| `YOUTUBE_API_KEY`, `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `CATBOX_USERHASH`, `VIDEY_API_KEY`, `VIDEY_API_SECRET` | | | Third-party API credentials |

See [`ADMIN.md`](./ADMIN.md#environment-variables-reference) for the full
list of admin-panel tuning variables (`ADMIN_UPDATE_MAX_MB`,
`ADMIN_BACKUP_RETENTION`, `ADMIN_CANARY_PORT`, etc.).

## Manual Installation & Development

1. Clone the repository and run `npm install --omit=dev`.
2. Populate `.env` with the required keys (see above).
3. Start the server: `node clipper.js` or `npm run dev`.
4. Visit `http://localhost:4242` (clipper) and `http://localhost:4242/admin` (admin panel).

## License

GNU General Public License v3.0 — see [`LICENSE`](./LICENSE).
