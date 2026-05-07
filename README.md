<section>
    <h2>Overview</h2>
    <p>
        Stream Clipper is a production-ready utility designed to capture and process highlights from live broadcasts. By leveraging <code>yt-dlp</code> for stream resolution and <code>FFmpeg</code> for segmented recording, it provides a seamless way to generate high-quality <strong>.mp4</strong> clips from active live streams.
    </p>
</section>

<section>
    <h2>Key Features</h2>
    <ul>
        <li><strong>Broad Platform Support:</strong> Native handling for <strong>YouTube</strong>, <strong>Twitch</strong>, <strong>Kick</strong>, and <strong>Odysee</strong>.</li>
        <li><strong>Dynamic Quality Profiles:</strong> Support for multiple resolutions (360p, 720p, 1080p) to balance file size and visual fidelity.</li>
        <li><strong>Reliable Job Management:</strong> Powered by <code>better-sqlite3</code> with Write-Ahead Logging (WAL) for persistent, concurrent task tracking.</li>
        <li><strong>Instant Distribution:</strong> Integrated one-click uploads to hosting providers like <strong>Catbox</strong> and <strong>qu.ax</strong>.</li>
        <li><strong>Automated Hardening:</strong> Includes security scripts for <strong>UFW</strong> and <strong>Fail2ban</strong> to protect production instances.</li>
    </ul>
</section>

<section>
    <h2>Project Structure</h2>
    <pre><code>├── clipper.js           # Core Express router & job logic
├── public/
│   ├── clipper.html     # Responsive frontend UI
│   └── clipper.css      # Custom styling & dark mode
├── deploy.sh            # One-touch Ubuntu deployment script
├── harden.sh            # Security and firewall configuration
└── ecosystem.config.js  # PM2 process management

<section>
    <h2>Deployment</h2>
    <p>
        The project includes a <code>deploy.sh</code> script that automates the installation of Node.js 20, FFmpeg, Nginx, and SSL certificates via Certbot.
    </p>
    <pre><code># Deploy to an Ubuntu/Debian server
git clone https://github.com/Riotcoke123/clipper.git
cd clipper
bash deploy.sh
    <h3>Production Maintenance</h3>
    <p>Manage the application lifecycle using the included PM2 configuration:</p>
    <ul>
        <li><code>npm run prod</code>: Start the clipping engine in the background.</li>
        <li><code>npm run logs</code>: View real-time capture and system logs.</li>
        <li><code>bash harden.sh</code>: Apply firewall rules and rate-limiting.</li>
    </ul>
</section>

<section>
    <h2>Configuration</h2>
    <p>Modify behavior via environment variables or a <code>.env</code> file:</p>
    <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
        <tr style="border-bottom: 1px solid #2a2f42; text-align: left;">
            <th style="padding: 8px;">Variable</th>
            <th style="padding: 8px;">Description</th>
        </tr>
        <tr>
            <td style="padding: 8px;"><code>MAX_CLIP_SECONDS</code></td>
            <td style="padding: 8px;">Maximum length of a single clip (Default: 300s)</td>
        </tr>
        <tr>
            <td style="padding: 8px;"><code>CLIP_OUTPUT_DIR</code></td>
            <td style="padding: 8px;">Path where processed MP4s are stored</td>
        </tr>
        <tr>
            <td style="padding: 8px;"><code>DB_PATH</code></td>
            <td style="padding: 8px;">Path to the SQLite database file</td>
        </tr>
    </table>
</section>

<footer>
    <hr style="border: 0; border-top: 1px solid #2a2f42; margin: 40px 0 20px;">
    <p style="font-size: 0.85rem; color: #3d4560; text-align: center;">
        &copy; 2024 Riotcoke123 &bull; Licensed under ISC
    </p>
</footer>
