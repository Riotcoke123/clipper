
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
        ca-certificates \
        gosu && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
        -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY clipper.js          ./
COPY admin.js            ./
COPY update-guard.js     ./
COPY package.json        ./
COPY public/             ./public/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p public/clips temp logs backups .staging && \
    groupadd -r clipper && useradd -r -g clipper -d /app clipper && \
    chown -R clipper:clipper /app && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4242

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:4242/ > /dev/null || exit 1

# Container starts as root (needed once, to fix volume ownership below),
# then docker-entrypoint.sh immediately drops to the unprivileged `clipper`
# user via gosu before exec'ing node — the app process itself never runs
# as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "clipper.js"]
