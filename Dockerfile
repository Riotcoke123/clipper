
# ─── Stage 1: dependency installer ───────────────────────────────────────────
FROM node:20-slim AS deps

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# ─── Stage 2: runtime image ───────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
        -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY clipper.js   ./
COPY package.json ./
COPY public/      ./public/

RUN mkdir -p public/clips temp logs

EXPOSE 4242

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:4242/ > /dev/null || exit 1

CMD ["node", "clipper.js"]
