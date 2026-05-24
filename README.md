<header>
    <h1>Stream Clipper <small>v1.3</small></h1>
    <div style="display: flex; gap: 8px; margin-top: 10px; margin-bottom: 16px; flex-wrap: wrap;">
        <img src="https://img.shields.io/badge/version-v1.3-blue.svg?style=flat-square" alt="Version 1.3">
        <img src="https://img.shields.io/badge/license-GPL-brightgreen.svg?style=flat-square" alt="GPL License">
        <img src="https://img.shields.io/badge/Node.js-20-43853D?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20">
        <img src="https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="FFmpeg">
        <img src="https://img.shields.io/badge/SQLite-07405E?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
        <img src="https://img.shields.io/badge/PM2-2B037A?style=flat-square&logo=pm2&logoColor=white" alt="PM2">
        <img src="https://img.shields.io/badge/Nginx-009639?style=flat-square&logo=nginx&logoColor=white" alt="Nginx">
    </div>
    <p>High-performance automated highlight capture for live broadcasts.</p>
</header>

<section>
    <h2>Overview</h2>
    <p>
        Stream Clipper is a production-ready utility designed to capture and process highlights from live broadcasts. By leveraging <code>yt-dlp</code> for stream manifest resolution and <code>FFmpeg</code> for segmented recording, it provides a seamless way to generate high-quality <strong>.mp4</strong> clips from active live streams.
    </p>
    <p>
        The application avoids unreliable VOD-based scraping options by pre-resolving broadcasts to direct HLS manifest URLs. It then captures video directly from the stream's live edge or oldest available DVR frames, utilizing highly resilient reconnection parameters designed for modern live infrastructure.
    </p>
</section>

<section>
    <h2>Key Features</h2>
    <ul>
        <li><strong>Broad Platform Support:</strong> Native handling for <strong>YouTube</strong>, <strong>Twitch</strong>, and <strong>Kick</strong> with handle-to-stream resolution.</li>
        <li><strong>Live Preview:</strong> Real-time stream embedding in the UI to confirm the broadcast status before triggering a capture.</li>
        <li><strong>Dynamic Quality Profiles:</strong> Targeted scaling down to <strong>Low (360p)</strong>, <strong>Medium (720p)</strong>, or up to <strong>High (1080p)</strong> resolutions.</li>
        <li><strong>Reliable Job Management:</strong> Powered by a persistent <code>better-sqlite3</code> engine running under Write-Ahead Logging (WAL) mode for fast, concurrent status tracking.</li>
        <li><strong>Instant Distribution:</strong> Fully integrated one-click mirror uploads to <strong>Catbox</strong>, <strong>qu.ax</strong>, and <strong>Videy</strong> directly from the client interface.</li>
        <li><strong>Multi-Layered Security:</strong> Mandatory 32-character API key enforcement split into admin and browser tiers, Server-Side Request Forgery (SSRF) guards restricting stream target hosts, strict UUID validation, and an in-memory IP rate limiter segmented by route.</li>
        <li><strong>Production Infrastructure:</strong> Includes turn-key automation scripts for multi-stage system deployments, Nginx reverse proxy management, Let's Encrypt SSL configuration, and custom Fail2ban brute-force protection.</li>
    </ul>
</section>

<section>
    <h2>Project Structure</h2>
<pre><code>├── clipper.js            # Core Express app server, security middlewares & clipping router
├── ecosystem.config.js   # PM2 cluster configuration for forks, restart rules & logging paths
├── deploy.sh             # Fully automated production package installation, Nginx, and SSL script
├── harden.sh             # Server security setup deploying custom Fail2ban jail blocks and UFW rules
├── public/               # Web client directory containing frontend application code
│   ├── clipper.html      # Main operational web dashboard template
│   ├── clipper.css       # Fully responsive grid custom layouts with dark mode variables
│   ├── script.js         # Client-side validation, iframe embeds, and asynchronous polling logic
│   └── clips/            # Production storage directory for completed .mp4 clips
├── logs/                 # System log destination managing active PM2 standard out and error streams
├── temp/                 # Temporary working directory for staging incoming stream fragments
└── .env                  # Critical environment variable configuration file </code></pre>
</section>

<section>
    <h2>Installation & Deployment</h2>
    <p>Stream Clipper includes automated management scripts optimized for a clean installation on Ubuntu or Debian environments.</p>
    <h3>Automated Production Setup</h3>
    <p>Run the deployment routine as root to install all runtime packages (Node.js 20, FFmpeg, yt-dlp, Nginx, Certbot), mirror app targets, and configure Let's Encrypt SSL tracking:</p>
<pre><code># 1. Execute production deploy automation
bash deploy.sh

# 2. Lock down open ports and establish automated brute-force threat bans
bash harden.sh</code></pre>
</section>

<section>
    <h2>Configuration</h2>
    <p>
        The application <strong>will refuse to start</strong> if a <code>CLIPPER_API_KEY</code> containing at least 32 characters is missing from the environment. You can generate a cryptographically secure 32-character hex key string by running:
    </p>
<pre><code>node -e "require('crypto').randomBytes(32).toString('hex')|0 && process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"</code></pre>
    <p>Configure the following variables within your local <code>.env</code> file:</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; margin-top: 10px; width: 100%; text-align: left;">
        <thead>
            <tr style="background-color: #1c2030; color: #fff;">
                <th>Variable</th>
                <th>Description</th>
                <th>Default </th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><code>PORT</code></td>
                <td>The port the Express server listens on.</td>
                <td><code>4242</code></td>
            </tr>
            <tr>
                <td><code>CLIPPER_API_KEY</code></td>
                <td><strong>Required.</strong> Security authentication credential for server/admin requests. Must be 32+ chars.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>CLIPPER_BROWSER_KEY</code></td>
                <td>Separate browser-facing key provided to the frontend payload.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>MAX_CLIP_SECONDS</code></td>
                <td>Maximum allowable duration ceiling for a single captured clip.</td>
                <td><code>300</code></td>
            </tr>
            <tr>
                <td><code>DEFAULT_CLIP_SECS</code></td>
                <td>Standard recording duration if an explicit length is not requested.</td>
                <td><code>60</code></td>
            </tr>
            <tr>
                <td><code>MAX_CONCURRENT_JOBS</code></td>
                <td>The maximum number of resolution, capture, and encoding instances running simultaneously.</td>
                <td><code>3</code></td>
            </tr>
            <tr>
                <td><code>FFMPEG_THREADS</code></td>
                <td>Number of threads allocated for FFmpeg video encoding.</td>
                <td><code>2</code></td>
            </tr>
            <tr>
                <td><code>YTDLP_CONCURRENT_FRAGS</code></td>
                <td>Number of concurrent fragment downloads permitted by yt-dlp.</td>
                <td><code>3</code></td>
            </tr>
            <tr>
                <td><code>CLIP_MAX_AGE_HOURS</code></td>
                <td>How long to keep completed clip files on disk before auto-deleting them.</td>
                <td><code>1</code></td>
            </tr>
            <tr>
                <td><code>DB_PATH</code></td>
                <td>Path to host the tracking SQLite database file.</td>
                <td><code>./clipper.db</code></td>
            </tr>
            <tr>
                <td><code>CLIP_OUTPUT_DIR</code></td>
                <td>Target destination directory where final MP4 recordings are written.</td>
                <td><code>./public/clips</code></td>
            </tr>
            <tr>
                <td><code>CLIP_TEMP_DIR</code></td>
                <td>Scratch workspace where raw un-transcoded live data streams are buffered.</td>
                <td><code>./temp</code></td>
            </tr>
            <tr>
                <td><code>USER_AGENT</code></td>
                <td>Custom User-Agent string used for web scraping and API requests.</td>
                <td><code>Mozilla/5.0...</code></td>
            </tr>
            <tr>
                <td><code>YOUTUBE_API_KEY</code></td>
                <td>YouTube Data API v3 token for rapid handle-to-live channel resource resolutions.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>KICK_CLIENT_ID</code><br><code>KICK_CLIENT_SECRET</code></td>
                <td>OAuth credentials for Kick developer API validation.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>CATBOX_USERHASH</code></td>
                <td>Optional hash key to tie Catbox file uploads permanently to an account.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>VIDEY_API_KEY</code><br><code>VIDEY_API_SECRET</code></td>
                <td>Videy provider API credentials to authorize mirror clip uploads.</td>
                <td>None</td>
            </tr>
        </tbody>
    </table>
</section>

<footer style="margin-top: 48px; padding: 24px; background-color: #141720; border: 1px solid #2a2f42; border-radius: 10px; text-align: center; font-family: 'Inter', sans-serif;">
    <div style="display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 8px;">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2dd97a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <h3 style="color: #e8ebf4; margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;">GNU General Public License</h3>
    </div>
    <p style="color: #6e7a9a; font-size: 14px; margin: 0; line-height: 1.5;">
        Stream Clipper is open-source software. You are free to use, modify, and distribute this project under the terms of the GPL.
    </p>
</footer>
