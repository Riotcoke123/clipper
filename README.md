<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">

</head>
<body>

<div class="container">
    <header>
        <h1>Clipper</h1>
        <p>A high-performance Node.js service for real-time stream capturing and automated video clipping.</p>
        <div style="margin-top: 20px;">
            <span class="badge">Node.js</span>
            <span class="badge">Express</span>
            <span class="badge">FFmpeg</span>
            <span class="badge">yt-dlp</span>
        </div>
    </header>
    <section id="overview">
        <h2>🚀 Overview</h2>
        <p><b>Clipper</b> is a robust backend engine designed to automate the process of capturing segments from live streams. By integrating industry-standard tools like <code>yt-dlp</code> and <code>FFmpeg</code>, it provides a seamless workflow from live ingestion to cloud-ready distribution.</p>
        <ul>
            <li><b>Dynamic Capturing:</b> Ingest live content across various quality profiles.</li>
            <li><b>Automated Transcoding:</b> Instant conversion to web-optimized H.264 formats.</li>
            <li><b>Cloud Integration:</b> One-click uploads to anonymous hosting services.</li>
        </ul>
    </section>
    <section id="tech-stack">
        <h2>🛠 Tech Stack</h2>
        <table>
            <thead>
                <tr>
                    <th>Core Technology</th>
                    <th>Implementation</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><b>Runtime</b></td>
                    <td>Node.js (v16+)</td>
                </tr>
                <tr>
                    <td><b>Processing</b></td>
                    <td>FFmpeg (libx264/aac)</td>
                </tr>
                <tr>
                    <td><b>Ingestion</b></td>
                    <td>yt-dlp (Daily updates)</td>
                </tr>
                <tr>
                    <td><b>Storage</b></td>
                    <td>Local Buffer with TTL Cleanup</td>
                </tr>
            </tbody>
        </table>
    </section>
    <section id="installation">
        <h2>📦 Installation</h2>
        <p>Ensure you have <b>FFmpeg</b> and <b>yt-dlp</b> installed on your host system before proceeding.</p>
        <pre><code># Clone the repo
git clone https://github.com/Riotcoke123/clipper.git

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Fire up the engine
npm start</code></pre>
    </section>
    <section id="api">
        <h2>🛰 API Reference</h2>
        <h3>POST /api/capture-stream</h3>
        <p>Initiates a background capture job.</p>
        <pre><code>{
  "url": "https://twitch.tv/example",
  "quality": "high",
  "duration": 60
}</code></pre>
        <h3>GET /api/capture-status/:captureId</h3>
        <p>Retrieves real-time progress and generated preview URLs.</p>
    </section>

</div>

</body>
</html>
