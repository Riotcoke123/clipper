<main>
    <header>
        <img src="https://github.com/user-attachments/assets/77f2d8f4-c842-4101-b285-d001d878ba23" alt="Stream Clipper Hero" class="hero-img">
        <h1>Stream Clipper v1.0</h1>
        <p style="font-size: 1.2rem; color: var(--text-muted);">
            A high-performance, multi-platform live stream clipping engine powered by <strong>Node.js</strong>, <strong>FFmpeg</strong>, and <strong>SQLite</strong>.
        </p>
    </header>
    <section id="features">
        <h2>🚀 Core Features</h2>
        <div class="grid">
            <div class="card">
                <h3>Multi-Platform</h3>
                <p>Native integration for YouTube, Twitch, Kick, and Odysee using platform APIs and <code>yt-dlp</code> fallbacks.</p>
            </div>
            <div class="card">
                <h3>Smart Engine</h3>
                <p>Automatically identifies HLS manifests and handles browser impersonation to bypass bot detection.</p>
            </div>
            <div class="card">
                <h3>Job Persistence</h3>
                <p>Reliable tracking via a SQLite-backed store with WAL mode for high-performance concurrent writes[cite: 3].</p>
            </div>
            <div class="card">
                <h3>Auto-Cleanup</h3>
                <p>Finished clips are streamed to clients and automatically deleted to maintain server disk health[cite: 3].</p>
            </div>
        </div>
    </section>
    <section id="config">
        <h2>🛠 Environment Setup</h2>
        <p>Define these variables in your <code>.env</code> file to customize the engine:</p>
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
                    <td>Hard cap on requested clip duration</td>
                    <td><code>300</code>[cite: 1, 3]</td>
                </tr>
                <tr>
                    <td><code>CLIP_OUTPUT_DIR</code></td>
                    <td>Path for finished MP4 storage</td>
                    <td><code>./public/clips</code>[cite: 1, 3]</td>
                </tr>
                <tr>
                    <td><code>DB_PATH</code></td>
                    <td>SQLite database file location</td>
                    <td><code>./clipper.db</code>[cite: 1, 3]</td>
                </tr>
                <tr>
                    <td><code>CLIP_TEMP_DIR</code></td>
                    <td>Scratch space during capture</td>
                    <td><code>./temp</code>[cite: 3]</td>
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
app.use('/api/clipper', clipper.router);[cite: 1, 3]</code></pre>
        <h3>Standalone Execution</h3>
        <p>Launch the built-in server on port <code>4242</code>[cite: 1, 3]:</p>
        <pre><code>node clipper.js</code></pre>
    </section>
    <section id="api">
        <h2>📡 API Reference</h2>
        <h3><code>POST /api/clipper/clip</code></h3>
        <p>Initiates a background capture job[cite: 3].</p>
        <pre><code>{
  "platform": "twitch",
  "username": "xqc",
  "duration": 60,
  "quality": "high"
}</code></pre>
        <h3><code>GET /api/clipper/clip/:jobId</code></h3>
        <p>Poll for status. Stages: <span class="badge">pending</span> <span class="badge">resolving</span> <span class="badge">capturing</span> <span class="badge">encoding</span> <span class="badge">ready</span>[cite: 3].</p>
        <h3><code>POST /api/clipper/clip/:jobId/catbox</code></h3>
        <p>Server-side proxy to upload the finished clip to Catbox anonymously[cite: 3].</p>
    </section>
    <footer style="margin-top: 80px; text-align: center; color: var(--text-dim); font-family: 'JetBrains Mono'; font-size: 0.8rem;">
        &copy; 2026 Stream Clipper Engine · Powered by Node.js & FFmpeg
    </footer>
</main>
