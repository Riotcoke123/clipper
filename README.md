<div align="center">

<img width="785" height="888" alt="Untitled" src="https://github.com/user-attachments/assets/90d5f035-1bf7-479c-8a4d-8b9227f9f8a2" />


<h1>🎬 Stream Clipper</h1>

<p>
  <a href="https://opensource.org/licenses/ISC"><img src="https://img.shields.io/badge/License-ISC-amber.svg" alt="License: ISC" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-18+-green.svg" alt="Node.js Version" /></a>
  <a href="#prerequisites"><img src="https://img.shields.io/badge/dependencies-Express%20%7C%20FFmpeg%20%7C%20yt--dlp-blue.svg" alt="Dependencies" /></a>
</p>

<p><b>Stream Clipper</b> is a high-performance, web-based tool designed to capture and download clips from live streams across multiple platforms in real-time. Built with a sleek, terminal-inspired dark UI and a robust Node.js backend.</p>

</div>

<hr />

<h2>✨ Features</h2>
<ul>
  <li><strong>Multi-Platform Support</strong>: Seamlessly resolve and capture streams from YouTube, Twitch, Kick, Odysee, and Vaughn.live.</li>
  <li><strong>Dynamic Duration</strong>: Capture anywhere from 5 to 300 seconds of live footage.</li>
  <li><strong>Quality Selection</strong>: Choose between <strong>360p (Low)</strong>, <strong>720p (Medium)</strong>, or <strong>1080p (High)</strong>.</li>
  <li><strong>Real-Time Progress</strong>: Live job tracking via a custom polling API with status updates (Resolving, Capturing, Encoding).</li>
  <li><strong>Pro UI</strong>: Cyberpunk-inspired dashboard featuring scanline textures, JetBrains Mono typography, and amber-glow accents.</li>
</ul>

<hr />

<h2>🛠️ Tech Stack</h2>
<ul>
  <li><strong>Frontend</strong>: HTML5, CSS3 (Custom Variables), Vanilla JavaScript.</li>
  <li><strong>Backend</strong>: Node.js, Express, and <code>better-sqlite3</code> for robust SQLite-backed job storage.</li>
  <li><strong>Processing</strong>: <code>fluent-ffmpeg</code> for encoding and <code>yt-dlp</code> for stream extraction.</li>
  <li><strong>Utilities</strong>: <code>dotenv</code> for configuration, <code>uuid</code> for job tracking, and <code>node-fetch</code> for API interactions.</li>
</ul>

<hr />

<h2>🚀 Getting Started</h2>

<h3>Prerequisites</h3>
<p>You <strong>must</strong> have the following installed on your system path:</p>
<ol>
  <li><strong>Node.js</strong> (v18 or higher)</li>
  <li><strong>FFmpeg</strong>: Required for video transcoding and clipping.</li>
  <li><strong>yt-dlp</strong>: Required for resolving live HLS/FLV manifests.</li>
</ol>

<h3>Installation</h3>
<ol>
  <li>
    <strong>Clone the repository:</strong>
<pre><code>git clone https://github.com/Riotcoke123/clipper.git
cd clipper</code></pre>
  </li>
  <li>
    <strong>Install dependencies:</strong>
<pre><code>npm install</code></pre>
  </li>
  <li>
    <strong>Configure Environment (Optional):</strong><br/>
    Create a <code>.env</code> file in the root directory to override defaults:
<pre><code>PORT=4242
CLIP_OUTPUT_DIR=./public/clips
CLIP_TEMP_DIR=./temp
MAX_CLIP_SECONDS=300
DEFAULT_CLIP_SECS=60
DB_PATH=./clipper.db</code></pre>
  </li>
  <li>
    <strong>Start the server:</strong>
<pre><code>npm start</code></pre>
    <p>The application will be available at <code>http://localhost:4242</code>.</p>
  </li>
</ol>

<hr />

<h2>🛰️ API Documentation</h2>
<p>Stream Clipper can be mounted as an Express router or used via its standalone REST API.</p>

<table>
  <thead>
    <tr>
      <th>Endpoint</th>
      <th>Method</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>/api/clipper/clip</code></td>
      <td><code>POST</code></td>
      <td>Starts a new clipping job (requires <code>platform</code> and <code>username</code>).</td>
    </tr>
    <tr>
      <td><code>/api/clipper/clip/:jobId</code></td>
      <td><code>GET</code></td>
      <td>Returns the current status and progress of a job.</td>
    </tr>
    <tr>
      <td><code>/api/clipper/clip/:jobId/download</code></td>
      <td><code>GET</code></td>
      <td>Downloads the finished <code>.mp4</code> file and subsequently deletes it to save disk space.</td>
    </tr>
    <tr>
      <td><code>/api/clipper/clip/:jobId</code></td>
      <td><code>DELETE</code></td>
      <td>Cancels or discards a job and deletes its output file.</td>
    </tr>
    <tr>
      <td><code>/api/clipper/jobs</code></td>
      <td><code>GET</code></td>
      <td>Lists all jobs (most recent first, maximum of 100).</td>
    </tr>
    <tr>
      <td><code>/api/clipper/platforms</code></td>
      <td><code>GET</code></td>
      <td>Lists supported platforms and expected username input examples.</td>
    </tr>
  </tbody>
</table>

<hr />

<h2>📋 Supported Platforms</h2>
<table>
  <thead>
    <tr>
      <th>Platform</th>
      <th>Input Format</th>
      <th>Method</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>YouTube</strong></td>
      <td><code>@handle</code> or Full URL</td>
      <td><code>yt-dlp</code> &rarr; HLS</td>
    </tr>
    <tr>
      <td><strong>Twitch</strong></td>
      <td><code>username</code></td>
      <td><code>yt-dlp</code> &rarr; HLS</td>
    </tr>
    <tr>
      <td><strong>Kick</strong></td>
      <td><code>username</code></td>
      <td>Kick API &rarr; HLS / yt-dlp fallback</td>
    </tr>
    <tr>
      <td><strong>Odysee</strong></td>
      <td><code>@Channel</code> or Full URL</td>
      <td>Odysee Live API &rarr; HLS / yt-dlp fallback</td>
    </tr>
    <tr>
      <td><strong>Vaughn.live</strong></td>
      <td><code>username</code></td>
      <td>Direct FLV CDN &rarr; FFmpeg</td>
    </tr>
  </tbody>
</table>

<hr />

<h2>⚖️ License</h2>
<p>Distributed under the <strong>ISC License</strong>. See <code>package.json</code> for more information.</p>
<p><strong>Author</strong>: <a href="https://github.com/Riotcoke123">Riotcoke123</a></p>
