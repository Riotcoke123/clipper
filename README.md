# Video Clip Creator

A web-based tool for creating clips from live streams on YouTube, Kick.com, and Parti.com and uploading them to pomf.lain.la.

![Video Clipper Screenshot](screenshot.png)

## Features

- Create clips up to 4 minutes long from live streams
- Support for YouTube, Kick.com, and Parti.com
- Visual preview before creating clips
- Custom time window selection
- Multiple quality options
- Automatic upload to pomf.lain.la
- MP4 format output
- Mobile-friendly interface

## Technologies Used

- **Frontend**: React.js with modern CSS
- **Backend**: Node.js with Express
- **Video Processing**: FFmpeg
- **Stream Capture**: yt-dlp
- **Deployment**: Docker support for easy hosting

## Installation

### Prerequisites

- Node.js (v14 or later)
- FFmpeg
- yt-dlp

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/video-clip-creator.git
   cd video-clip-creator
   ```

2. Install dependencies:
   ```bash
   # Install backend dependencies
   npm install
   
   # Install frontend dependencies
   cd client
   npm install
   cd ..
   ```

3. Create required directories:
   ```bash
   mkdir -p temp public/clips
   ```

4. Create a `.env` file with your configuration:
   ```
   PORT=5000
   NODE_ENV=development
   ```

## Usage

### Development Mode

1. Start the backend server:
   ```bash
   npm run server
   ```

2. In another terminal, start the frontend:
   ```bash
   cd client
   npm start
   ```

3. Access the application at `http://localhost:3000`

### Production Mode

1. Build the frontend:
   ```bash
   cd client
   npm run build
   cd ..
   ```

2. Start the production server:
   ```bash
   npm start
   ```

3. Access the application at `http://localhost:5000`

## Docker Deployment

You can use Docker to simplify deployment:

```bash
# Build the Docker image
docker build -t video-clip-creator .

# Run the container
docker run -p 5000:5000 video-clip-creator
```

## Using the Application

1. Enter the URL of a live stream from YouTube, Kick.com, or Parti.com
2. Select the desired quality level
3. Click "Download Stream" to capture a segment
4. Use the preview to select the exact portion you want to clip
5. Adjust the start time and duration using the sliders
6. Click "Create Clip" to generate your clip
7. The clip will be automatically uploaded to pomf.lain.la
8. Copy the provided URL to share your clip

## API Endpoints

- `POST /api/capture-stream` - Captures a segment of a live stream
- `GET /api/capture-status/:captureId` - Checks the status of a capture
- `POST /api/create-clip` - Creates a clip from a captured stream
- `POST /api/upload-clip` - Uploads a clip to pomf.lain.la

## Limitations

- Maximum clip duration is 4 minutes (240 seconds)
- pomf.lain.la has a file size limit of 1 GiB
- Streaming sites may have their own limitations or restrictions

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This tool is for personal use only. Always respect the terms of service of the platforms you interact with and ensure you have the necessary permissions to clip and share content.
