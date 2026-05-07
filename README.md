
<header>
    <h1>Stream Clipper</h1>
    <p>High-performance automated highlight capture for live broadcasts.</p>
</header>

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
└── ecosystem.config.js  # PM2 process management</code></pre>
</section>

<section>
    <h2>Deployment</h2>
    <p>
        The project includes a <code>deploy.sh</code> script that automates the installation of Node.js 20, FFmpeg, Nginx, and SSL certificates via Certbot.
    </p>
<pre><code># Deploy to an Ubuntu/Debian server
git clone https://github.com/Riotcoke123/clipper.git
cd clipper
bash deploy.sh</code></pre>
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
    <table>
        <thead>
            <tr>
                <th>Variable</th>
                <th>Description</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><code>MAX_CLIP_SECONDS</code></td>
                <td>Maximum length of a single clip (Default: 300s)</td>
            </tr>
            <tr>
                <td><code>CLIP_OUTPUT_DIR</code></td>
                <td>Path where processed MP4s are stored</td>
            </tr>
            <tr>
                <td><code>DB_PATH</code></td>
                <td>Path to the SQLite database file</td>
            </tr>
        </tbody>
    </table>
</section>

<footer>
    <p>&copy; 2024 Riotcoke123 &bull; Licensed under ISC</p>
</footer>

</body>
</html>
