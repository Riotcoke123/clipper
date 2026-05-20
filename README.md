<header>
    <h1>Stream Clipper <small>v1.1</small></h1>
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
        <li><strong>Multi-Layered Security:</strong> Mandatory 32-character API key enforcement, Server-Side Request Forgery (SSRF) guards restricting stream target hosts, strict UUID validation, and an in-memory IP rate limiter.</li>
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
└── .env                  # Critical environment variable configuration file</code></pre>
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
    <h3>Manual Configuration</h3>
    <p>If configuring your local or cloud platform step by step, handle the setup manually via terminal package managers:</p>
<pre><code># Install base encoding and persistent storage runtimes
sudo apt-get update
sudo apt-get install -y ffmpeg sqlite3 build-essential

# Pull down the latest standalone executable release of yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Clone repository, navigate inside, and construct dependency trees
git clone https://github.com/Riotcoke123/clipper.git
cd clipper
npm install

# Initialize your required variables within an environment file
cp .env.example .env

# Fire up background management threads via PM2
pm2 start ecosystem.config.js</code></pre>
</section>

<section>
    <h2>Configuration</h2>
    <p>
        The application <strong>will refuse to start</strong> if a <code>CLIPPER_API_KEY</code> containing at least 32 characters is missing from the environment. You can generate a cryptographically secure 32-character hex key string by running:
    </p>
<pre><code>node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"</code></pre>
    <p>Configure the following variables within your local <code>.env</code> file:</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; margin-top: 10px;">
        <thead>
            <tr style="background-color: #1c2030; color: #fff;">
                <th>Variable</th>
                <th>Description</th>
                <th>Default</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><code>CLIPPER_API_KEY</code></td>
                <td><strong>Required.</strong> Security authentication credential for modifying, deleting, or initiating encoding actions.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>MAX_CLIP_SECONDS</code></td>
                <td>Maximum allowable duration ceiling for a single captured clip request.</td>
                <td><code>300</code></td>
            </tr>
            <tr>
                <td><code>DEFAULT_CLIP_SECS</code></td>
                <td>Standard recording duration utilized if an explicit runtime length is not requested by the user.</td>
                <td><code>60</code></td>
            </tr>
            <tr>
                <td><code>MAX_CONCURRENT_JOBS</code></td>
                <td>The maximum number of background resolution, capture, and encoding instances allowed to run simultaneously.</td>
                <td><code>5</code></td>
            </tr>
            <tr>
                <td><code>DB_PATH</code></td>
                <td>The relative or absolute filesystem directory path mapped to host the tracking SQLite database file.</td>
                <td><code>./clipper.db</code></td>
            </tr>
            <tr>
                <td><code>YOUTUBE_API_KEY</code></td>
                <td>Optional YouTube Data API v3 token used to perform rapid handle-to-live channel resource resolutions.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>CATBOX_USERHASH</code></td>
                <td>Optional hash key used to tie web dashboard Catbox file uploads permanently to a custom repository account.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>VIDEY_API_KEY</code></td>
                <td>Optional Videy provider API key used to authorize remote mirror clip uploads via the dashboard interface.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>RATE_LIMIT_WINDOW_MS</code></td>
                <td>The time window duration configuration for the built-in core API memory-backed IP rate limiter (in milliseconds).</td>
                <td><code>900000</code> <small>(15 min)</small></td>
            </tr>
            <tr>
                <td><code>RATE_LIMIT_MAX_REQ</code></td>
                <td>The maximum request limit threshold allowed from an individual source IP address during a rate limit window.</td>
                <td><code>15</code></td>
            </tr>
            <tr>
                <td><code>CLIP_OUTPUT_DIR</code></td>
                <td>Target destination directory where final structured highlight MP4 recordings are written.</td>
                <td><code>./public/clips</code></td>
            </tr>
            <tr>
                <td><code>CLIP_TEMP_DIR</code></td>
                <td>Scratch workspace where raw un-transcoded live data streams are buffered.</td>
                <td><code>./temp</code></td>
            </tr>
            <tr>
                <td><code>KICK_API_BASE</code></td>
                <td>Base API route domain used when communicating with Kick platform interfaces.</td>
                <td><code>https://api.kick.com</code></td>
            </tr>
            <tr>
                <td><code>KICK_AUTH_BASE</code></td>
                <td>Authentication credential service endpoint used during Kick verification transactions.</td>
                <td><code>https://id.kick.com</code></td>
            </tr>
            <tr>
                <td><code>KICK_CLIENT_ID</code></td>
                <td>Optional OAuth Client identifier for Kick developer API validation rules.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>KICK_CLIENT_SECRET</code></td>
                <td>Optional App Client Secret string associated with proprietary Kick API pipelines.</td>
                <td>None</td>
            </tr>
        </tbody>
    </table>
</section>

<footer>
    <p>Licensed under GNU GENERAL PUBLIC LICENSE</p>
</footer>
