<header>
    <h1>Stream Clipper <small>v1.4</small></h1>
    <div style="display: flex; gap: 8px; margin-top: 10px; margin-bottom: 16px; flex-wrap: wrap;">
        <img src="https://img.shields.io/badge/version-v1.3.1-blue.svg?style=flat-square" alt="Version 1.3.1">
        <img src="https://img.shields.io/badge/license-GPL-brightgreen.svg?style=flat-square" alt="GPL License">
        <img src="https://img.shields.io/badge/Node.js-20-43853D?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20">
        <img src="https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="FFmpeg">
        <img src="https://img.shields.io/badge/SQLite-07405E?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
        <img src="https://img.shields.io/badge/PM2-2B037A?style=flat-square&logo=pm2&logoColor=white" alt="PM2">
        <img src="https://img.shields.io/badge/Nginx-009639?style=flat-square&logo=nginx&logoColor=white" alt="Nginx">
        <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    </div>
</header>

<h2>Overview</h2>
<p>Stream Clipper is a multi-platform live stream clipper tool designed to capture video segments from YouTube, Twitch, and Kick. It allows users to set specific durations, pick video qualities, and generate downloadable MP4s directly from a live stream. Additionally, it supports direct one-click server-side proxy uploads to file-hosting services like Catbox, qu.ax, and Videy.</p>

<h2>Features</h2>
<ul>
    <li><strong>Multi-Platform Support:</strong> Extract clips from YouTube, Twitch, and Kick live streams.</li>
    <li><strong>DVR Rewind:</strong> A rewind slider UI allows users to capture moments from earlier in the stream (up to 120 seconds back via the UI, with the backend supporting up to 300 seconds). The backend utilizes a <code>startOffset</code> parameter to seek directly into the HLS DVR buffer for precise historical clipping.</li>
    <li><strong>Advanced YouTube Extraction:</strong> Uses <code>yt-dlp</code> to hit the YouTube Android <code>player_client</code> innertube API. This bypasses PO Token requirements for VPS/datacenter IPs and avoids the channel-page scraper that frequently causes 404 errors.</li>
    <li><strong>Direct HLS Capture:</strong> Pre-resolves Twitch and Kick streams to direct HLS URLs, passing them straight to native FFmpeg for highly reliable live-edge clipping instead of relying on <code>yt-dlp</code> section downloads.</li>
    <li><strong>Direct Uploads:</strong> Instantly push clipped MP4 files to Catbox, qu.ax, or Videy through dedicated server-side proxy routes.</li>
    <li><strong>Live Previews:</strong> Embedded iframe support to preview streams before clipping, featuring a mobile-friendly touch shield to prevent layout issues.</li>
    <li><strong>Automated Cleanup:</strong> Background jobs run every 30 minutes to automatically remove stale MP4 clips and temporary raw files, keeping disk usage strictly bounded.</li>
    <li><strong>Database Analytics:</strong> Powered by SQLite (in WAL mode for concurrency), the database tracks clip counts, unique users, and total stream durations, and features updated migrations for <code>startOffset</code> and original URL logging.</li>
    <li><strong>Rate Limiting & Security:</strong> Built-in per-IP rate limiters prevent API abuse (capped at 5 clips per minute), paired with session-based authentication to keep the master API key entirely off the frontend.</li>
</ul>

<h2>Prerequisites</h2>
<p>If you are setting this up manually or natively, ensure your system has the following installed:</p>
<ul>
    <li>Node.js v18 or higher (Node 20 LTS recommended)</li>
    <li>yt-dlp (latest version)</li>
    <li>FFmpeg</li>
    <li>SQLite3</li>
    <li><em>Or simply use Docker (see below).</em></li>
</ul>

<h2>Docker Deployment (Recommended)</h2>
<p>The most reliable and isolated way to deploy Stream Clipper is via Docker.</p>

<ol>
    <li>Make sure <strong>Docker</strong> and <strong>Docker Compose</strong> are installed on your host system.</li>
    <li>Clone the repository and copy the example environment file:
        <pre><code>cp .env.example .env</code></pre>
    </li>
    <li>Configure your <code>.env</code> file with your API keys and secure <code>CLIPPER_API_KEY</code>.</li>
    <li>Build and start the container in detached mode:
        <pre><code>docker compose up -d --build</code></pre>
    </li>
</ol>

<h3>Docker Architecture Notes</h3>
<ul>
    <li><strong>Persistent Volumes:</strong> The Compose file automatically creates isolated volumes for your SQLite database (<code>clipper-db</code>), generated MP4 clips (<code>clipper-clips</code>), temp processing files (<code>clipper-temp</code>), and logs (<code>clipper-logs</code>) so you don't lose data on container rebuilds.</li>
    <li><strong>Security Constraints:</strong> The container drops all unused Linux capabilities (<code>cap_drop: ALL</code>) to limit the blast radius if the app misbehaves.</li>
    <li><strong>Resource Limits:</strong> To prevent FFmpeg from starving your host server, the container is hard-capped at 1GB of memory and 2 CPU cores.</li>
    <li><strong>Networking:</strong> By default, the app is exposed purely to <code>127.0.0.1:4242</code>. It is highly recommended to route external traffic through a reverse proxy (like Nginx) to handle HTTPS.</li>
</ul>

<h2>Automated Deployment (Ubuntu/Debian)</h2>
<p>If you prefer a native, non-Docker installation, a comprehensive deployment script is included to provision a server from scratch. It automatically installs Nginx, Let's Encrypt (Certbot), PM2, FFmpeg, Node.js 20, and yt-dlp.</p>

<pre><code>chmod +x deploy.sh
sudo ./deploy.sh</code></pre>

<p>You can also apply strict SSH, UFW, and Fail2ban security rules (including custom Nginx 4xx flood filters to catch bad bots and scanners) using the included hardening script:</p>

<pre><code>chmod +x harden.sh
sudo ./harden.sh</code></pre>

<h2>Environment Variables</h2>
<p>Configure the application by setting up a <code>.env</code> file in the root directory. Key variables utilized include:</p>
<ul>
    <li><code>PORT</code>: The port the app runs on (default: 4242).</li>
    <li><code>CLIPPER_API_KEY</code>: Required 32+ character admin security token.</li>
    <li><code>CLIPPER_BROWSER_KEY</code>: (Optional) Separate token used for browser sessions.</li>
    <li><code>MAX_CLIP_SECONDS</code>: Maximum allowable duration for a single clip (default: 300).</li>
    <li><strong>API Credentials:</strong> <code>YOUTUBE_API_KEY</code>, <code>KICK_CLIENT_ID</code>, <code>KICK_CLIENT_SECRET</code>, <code>CATBOX_USERHASH</code>, <code>VIDEY_API_KEY</code>, and <code>VIDEY_API_SECRET</code>.</li>
</ul>

<h2>Manual Installation & Development</h2>
<p>To run the application locally without Docker or the automated deployment script:</p>
<ol>
    <li>Clone the repository and run <code>npm install --omit=dev</code>.</li>
    <li>Ensure your <code>.env</code> is fully populated with the required keys.</li>
    <li>Start the server in development mode using <code>node clipper.js</code> or <code>npm run dev</code>.</li>
    <li>The application will be accessible locally at <code>http://localhost:4242</code>.</li>
</ol>

<h2>License</h2>
<p>This project is licensed under the GNU General Public License v3.0.</p>
