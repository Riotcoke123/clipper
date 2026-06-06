# ─── Stage 1: dependency installer ───────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --silent

# ─── Stage 2: runtime image ───────────────────────────────────────────────────
FROM node:20-slim

# Install ffmpeg + yt-dlp runtime dependencies
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        python3 \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp (static binary)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY clipper.js       ./
COPY package.json     ./

# Copy frontend assets into public/
COPY public/          ./public/

# Create data directories
RUN mkdir -p public/clips temp logs

EXPOSE 4242

# Health check — polls the root path
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:4242/ > /dev/null || exit 1

CMD ["node", "clipper.js"]