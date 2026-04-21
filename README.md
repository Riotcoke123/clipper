<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

</head>
<body>

  <h1>Clipper 🎬</h1>
  
  <div class="badges">
    <a href="https://github.com/Riotcoke123/clipper">
      <img src="https://img.shields.io/badge/GitHub-Repository-blue?logo=github" alt="GitHub Repository">
    </a>
    <img src="https://img.shields.io/badge/License-GPL%20v3.0-green.svg" alt="License: GPL v3.0">
    <img src="https://img.shields.io/badge/Node.js-Backend-339933?logo=nodedotjs" alt="Node.js">
  </div>

  <p>A Node.js backend application designed to capture live streams and videos, generate specific clips, and seamlessly upload them to file-hosting services like Catbox, Buzzheavier, and Fileditch.</p>

  <p><strong>Repository URL:</strong> <a href="https://github.com/Riotcoke123/clipper">https://github.com/Riotcoke123/clipper</a></p>

  <h2>🛠 Prerequisites</h2>
  <p>Before running the application, ensure you have the following installed on your system:</p>
  <ul>
    <li><strong>Node.js</strong> (v14 or higher)</li>
    <li><strong><code>ffmpeg</code></strong> (Must be accessible via your system PATH)</li>
    <li><strong><code>yt-dlp</code></strong> (Must be accessible via your system PATH)</li>
  </ul>

  <h2>📦 Installation & Setup</h2>
  <p>Run the following Node.js boxes in your terminal to get the project up and running:</p>

  <h3>1. Clone and Install Dependencies</h3>
<pre><code>git clone https://github.com/Riotcoke123/clipper.git
cd clipper
npm install
</code></pre>

  <h3>2. Configure Environment Variables</h3>
  <p>Create a <code>.env</code> file in the root directory. You can customize the default values:</p>
<pre><code>PORT=5000
MAX_CAPTURE_DURATION=240
JOB_TTL_SECONDS=3600
CATBOX_UPLOAD_URL=https://catbox.moe/user/api.php
BUZZHEAVIER_UPLOAD_BASE=https://w.buzzheavier.com
FILEDITCH_UPLOAD_URL=https://new.fileditch.com/upload.php
</code></pre>

  <h3>3. Start the Server</h3>
<pre><code>npm start
# or run directly using:
node clipper.js
</code></pre>

  <h2>🚀 API Reference</h2>

  <h3>Capture Stream</h3>
  <p><code>POST /api/capture-stream</code></p>
  <ul>
    <li><strong>Body:</strong> <code>{ "url": "...", "platform": "...", "quality": "high|medium|low", "duration": 120 }</code></li>
    <li><strong>Description:</strong> Initiates a `yt-dlp` download of the specified stream/video.</li>
  </ul>

  <h3>Check Capture Status</h3>
  <p><code>GET /api/capture-status/:captureId</code></p>
  <ul>
    <li><strong>Description:</strong> Poll this endpoint to get download and transcoding progress.</li>
  </ul>

  <h3>Create Clip</h3>
  <p><code>POST /api/create-clip</code></p>
  <ul>
    <li><strong>Body:</strong> <code>{ "captureId": "...", "startTime": 10, "duration": 30 }</code></li>
    <li><strong>Description:</strong> Uses `ffmpeg` to trim the captured video to the specified timeframe.</li>
  </ul>

  <h3>Upload Clip</h3>
  <p><code>POST /api/upload-clip</code></p>
  <ul>
    <li><strong>Body:</strong> <code>{ "clipId": "...", "site": "catbox|buzzheavier|fileditch" }</code></li>
    <li><strong>Description:</strong> Uploads the final generated clip to the chosen anonymous file host.</li>
  </ul>

  <h3>Download Clip</h3>
  <p><code>GET /api/download-clip/:clipId</code></p>
  <ul>
    <li><strong>Description:</strong> Direct download link to retrieve the processed `.mp4` file directly to your device.</li>
  </ul>

  <h3>Health Check</h3>
  <p><code>GET /healthz</code></p>
  <ul>
    <li><strong>Description:</strong> Returns server uptime and active background jobs.</li>
  </ul>

  <h2>📄 License</h2>
  <p>This project is licensed under the <strong>GNU General Public License v3.0</strong>.</p>
  <p>Permissions of this strong copyleft license are conditioned on making available complete source code of licensed works and modifications, which include larger works using a licensed work, under the same license. Copyright and license notices must be preserved. Contributors provide an express grant of patent rights.</p>

</body>
</html>
