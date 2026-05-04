<div align="center">
<img width="1011" height="1200" alt="Untitled(1)" src="https://github.com/user-attachments/assets/77f2d8f4-c842-4101-b285-d001d878ba23" />
<header>
    <h1>CLIPPER</h1>
    <p>A high-performance, multi-platform live stream clipping engine powered by Node.js, FFmpeg, and SQLite[cite: 1].</p>
</header>

<section>
    <h2>🚀 Features</h2>
    <ul>
        <li><strong>Multi-Platform Support:</strong> Native integration for YouTube, Twitch, Kick, and Odysee[cite: 1].</li>
        <li><strong>Smart Resolution:</strong> Automatically identifies HLS manifests via platform-specific APIs or <code>yt-dlp</code> fallbacks[cite: 1].</li>
        <li><strong>Job Persistence:</strong> Uses a SQLite-backed job store with WAL mode for reliable tracking[cite: 1].</li>
        <li><strong>Flexible Deployment:</strong> Can be mounted as an Express router or run as a standalone server[cite: 1].</li>
        <li><strong>Quality Tiers:</strong> Supports low, medium, and high quality encoding presets[cite: 1].</li>
    </ul>
</section>

<section>
    <h2>🛠 Configuration</h2>
    <p>Configure the engine using environment variables in a <code>.env</code> file[cite: 1]:</p>
    <table>
        <thead>
            <tr>
                <th>Variable</th>
                <th>Description</th>
                <th>Default</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td><code>MAX_CLIP_SECONDS</code></td>
                <td>Hard cap on clip duration</td>
                <td><code>300</code>[cite: 1]</td>
            </tr>
            <tr>
                <td><code>CLIP_OUTPUT_DIR</code></td>
                <td>Path for finished MP4 files</td>
                <td><code>./public/clips</code>[cite: 1]</td>
            </tr>
            <tr>
                <td><code>DB_PATH</code></td>
                <td>SQLite database location</td>
                <td><code>./clipper.db</code>[cite: 1]</td>
            </tr>
        </tbody>
    </table>
</section>

<section>
    <h2>💻 Integration</h2>
    <h3>As an Express Module</h3>
    <pre><code>const express = require('express');
const clipper = require('./clipper');

const app = express();
app.use(express.json());

// Mount the clipper API
app.use('/api/clipper', clipper.router);[cite: 1]</code></pre>

    <h3>Standalone Mode</h3>
    <p>Simply run the file directly to start the built-in server on port 4242[cite: 1]:</p>
    <pre><code>node clipper.js</code></pre>
</section>

<section>
    <h2>📡 API Reference</h2>
    <h3><code>POST /api/clipper/clip</code></h3>
    <p>Initiates a new capture job[cite: 1].</p>
    <pre><code>// Body
{
  "platform": "twitch",
  "username": "xqc",
  "duration": 60,
  "quality": "high"
}</code></pre>
    <h3><code>GET /api/clipper/clip/:jobId</code></h3>
    <p>Returns the current job status and progress percentage[cite: 1]. Possible statuses include:</p>
    <ul>
        <li><code>pending</code>, <code>resolving</code>, <code>capturing</code>, <code>encoding</code>, <code>ready</code>, <code>error</code>[cite: 1].</li>
    </ul>
    <h3><code>GET /api/clipper/clip/:jobId/download</code></h3>
    <p>Streams the finished MP4 file to the client and automatically deletes it from the server after the transfer completes to save space[cite: 1].</p>
</section>

<footer>
    <p style="margin-top: 50px; font-size: 0.8rem; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 20px;">
        Generated for use with <code>clipper.js</code>[cite: 1].
    </p>
</footer>

</body>
</html>
