
<nav>
    <h1>CLIPPER</h1>
    <a href="#features">Features</a>
    <a href="#config">Configuration</a>
    <a href="#integration">Integration</a>
    <a href="#api">API Reference</a>
</nav>

<main>
    <header>
        <img src="https://github.com/user-attachments/assets/77f2d8f4-c842-4101-b285-d001d878ba23" alt="Clipper Hero" class="hero-img">
        <p style="font-size: 1.2rem; color: var(--text-secondary);">
            A high-performance, multi-platform live stream clipping engine powered by Node.js, FFmpeg, and SQLite[cite: 1].
        </p>
    </header>
    <section id="features">
        <h2>🚀 Core Features</h2>
        <div class="grid">
            <div class="card">
                <i class="fa-solid fa-layer-group"></i>
                <h3>Multi-Platform</h3>
                <p>Native integration for YouTube, Twitch, Kick, and Odysee[cite: 1].</p>
            </div>
            <div class="card">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <h3>Smart Resolution</h3>
                <p>Identifies HLS manifests via platform APIs or <code>yt-dlp</code> fallbacks[cite: 1].</p>
            </div>
            <div class="card">
                <i class="fa-solid fa-database"></i>
                <h3>Job Persistence</h3>
                <p>Uses a SQLite-backed job store with WAL mode for reliable tracking[cite: 1].</p>
            </div>
            <div class="card">
                <i class="fa-solid fa-server"></i>
                <h3>Flexible Mode</h3>
                <p>Mount as an Express router or run as a standalone server[cite: 1].</p>
            </div>
        </div>
    </section>
    <section id="config">
        <h2>🛠 Environment Setup</h2>
        <p>Define these variables in your <code>.env</code> file to customize the clipping engine[cite: 1]:</p>
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
    <section id="integration">
        <h2>💻 Integration</h2>
        <h3>As an Express Module</h3>
        <pre><code>const express = require('express');
const clipper = require('./clipper');
const app = express();
app.use(express.json());
// Mount the clipper API
app.use('/api/clipper', clipper.router);[cite: 1]</code></pre>
        <h3>Standalone Execution</h3>
        <p>Launch the built-in server on port 4242[cite: 1]:</p>
        <pre><code>node clipper.js</code></pre>
    </section>
    <section id="api">
        <h2>📡 API Reference</h2>
        <h3><code>POST /api/clipper/clip</code></h3>
        <p>Initiates a background capture job[cite: 1].</p>
        <pre><code>{
  "platform": "twitch",
  "username": "xqc",
  "duration": 60,
  "quality": "high"
}</code></pre>
        <h3><code>GET /api/clipper/clip/:jobId</code></h3>
        <p>Polling endpoint for status. Stages include <code>pending</code>, <code>resolving</code>, <code>capturing</code>, <code>encoding</code>, <code>ready</code>, or <code>error</code>[cite: 1].</p>
        <h3><code>GET /api/clipper/clip/:jobId/download</code></h3>
        <p>Streams the MP4 to the client and triggers <strong>auto-deletion</strong> from the server storage post-transfer to maintain disk health[cite: 1].</p>
    </section>
    <footer>
        <p>CLIPPER.JS — Automated Media Pipeline — 2026[cite: 1]</p>
    </footer>
</main>

</body>

