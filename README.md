<header>
    <h1>Stream Clipper <small>v1.1</small></h1>
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
        <li><strong>Broad Platform Support:</strong> Native handling for <strong>YouTube</strong>, <strong>Twitch</strong>, and <strong>Kick</strong>.</li>
        <li><strong>Live Preview:</strong> Real-time stream embedding in the UI to confirm the broadcast before clipping.</li>
        <li><strong>Dynamic Quality Profiles:</strong> Support for <strong>Low (360p)</strong>, <strong>Medium (720p)</strong>, and <strong>High (1080p)</strong> resolutions.</li>
        <li><strong>Reliable Job Management:</strong> Powered by <code>better-sqlite3</code> with Write-Ahead Logging (WAL) for persistent, concurrent task tracking.</li>
        <li><strong>Instant Distribution:</strong> Integrated one-click uploads to <strong>Catbox</strong> and <strong>qu.ax</strong>.</li>
        <li><strong>Enhanced Security:</strong> Mandatory 32-character API key enforcement, SSRF guards on stream URLs, and IP-based rate limiting.</li>
    </ul>
</section>

<section>
    <h2>Project Structure</h2>
<pre><code>├── clipper.js            # Core Express router & clipping logic
├── clipper.db            # SQLite database for job persistence
├── public/
│   ├── clipper.html      # Responsive frontend UI
│   ├── clipper.css       # Custom styling & dark mode
│   ├── script.js         # Frontend application logic
│   └── clips/            # Storage directory for processed MP4s
├── temp/                 # Temporary directory for raw stream fragments
├── ecosystem.config.js   # PM2 process management
└── .env                  # Environment configuration (see below)</code></pre>
</section>

<section>
    <h2>Installation & Deployment</h2>
    <p>Deploy to an Ubuntu/Debian server by installing Node.js 20, FFmpeg, and yt-dlp:</p>
<pre><code># Clone and install dependencies
git clone https://github.com/Riotcoke123/clipper.git
cd clipper
npm install

# Start the application
npm run prod</code></pre>
</section>

<section>
    <h2>Configuration</h2>
    <p>The application <strong>will not start</strong> without a <code>CLIPPER_API_KEY</code> of at least 32 characters. Configure your <code>.env</code> file accordingly:</p>
    <table border="1">
        <thead>
            <tr>
                <th>Variable</th>
                <th>Description</th>
                <th>Default</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><code>CLIPPER_API_KEY</code></td>
                <td><strong>Required.</strong> Security key for all mutating requests.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>MAX_CLIP_SECONDS</code></td>
                <td>Maximum length of a single clip.</td>
                <td>300</td>
            </tr>
            <tr>
                <td><code>MAX_CONCURRENT_JOBS</code></td>
                <td>Maximum simultaneous capture processes.</td>
                <td>5</td>
            </tr>
            <tr>
                <td><code>YOUTUBE_API_KEY</code></td>
                <td>Optional key to improve YouTube live resolution.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>CATBOX_USERHASH</code></td>
                <td>Optional hash for persistent Catbox uploads.</td>
                <td>None</td>
            </tr>
            <tr>
                <td><code>DB_PATH</code></td>
                <td>Path to the SQLite database file.</td>
                <td>./clipper.db</td>
            </tr>
        </tbody>
    </table>
</section>

<footer>
    <p>Licensed under GNU GENERAL PUBLIC LICENSE</p>
</footer>

