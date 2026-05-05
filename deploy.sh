#!/usr/bin/env bash
# deploy.sh — Full production setup for clipper.iceposeidon.network
# Run as root on 204.13.232.252:
#   bash deploy.sh
set -euo pipefail

DOMAIN="clipper.iceposeidon.network"
APP_DIR="/root/clipper"
NODE_MIN=18

echo "════════════════════════════════════════════════════"
echo "  Stream Clipper — Production Deploy"
echo "  Target: $DOMAIN → localhost:4242"
echo "════════════════════════════════════════════════════"

# ─── 1. System packages ──────────────────────────────────────────────────────
echo ""
echo "▶ [1/9] Updating packages & installing system deps..."
apt-get update -qq
apt-get install -y -qq \
    curl wget git build-essential \
    ffmpeg \
    nginx certbot python3-certbot-nginx \
    sqlite3

# ─── 2. Node.js ──────────────────────────────────────────────────────────────
echo ""
echo "▶ [2/9] Checking Node.js..."
if ! command -v node &>/dev/null || [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -lt "$NODE_MIN" ]; then
    echo "   Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "   Node $(node --version) — OK"
fi

# ─── 3. yt-dlp ───────────────────────────────────────────────────────────────
echo ""
echo "▶ [3/9] Installing / updating yt-dlp..."
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
echo "   yt-dlp $(yt-dlp --version)"

# ─── 4. PM2 ──────────────────────────────────────────────────────────────────
echo ""
echo "▶ [4/9] Installing PM2..."
npm install -g pm2 --silent
pm2 --version

# ─── 5. App directory & files ────────────────────────────────────────────────
echo ""
echo "▶ [5/9] Setting up $APP_DIR..."
mkdir -p "$APP_DIR"/{public/clips,temp,logs}

# Copy app files (run from same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "$SCRIPT_DIR/clipper.js"          "$APP_DIR/clipper.js"
cp "$SCRIPT_DIR/package.json"        "$APP_DIR/package.json"
cp "$SCRIPT_DIR/ecosystem.config.js" "$APP_DIR/ecosystem.config.js"
cp "$SCRIPT_DIR/clipper.html"        "$APP_DIR/public/clipper.html"
cp "$SCRIPT_DIR/clipper.css"         "$APP_DIR/public/clipper.css"

# Only write .env if it doesn't exist (preserve production secrets)
if [ ! -f "$APP_DIR/.env" ]; then
    cp "$SCRIPT_DIR/.env" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
    echo "   .env written — review $APP_DIR/.env before going live"
else
    echo "   .env already exists — skipping (kept existing)"
fi

# Fix permissions
chmod 700 "$APP_DIR"

# ─── 6. npm install ──────────────────────────────────────────────────────────
echo ""
echo "▶ [6/9] Installing npm dependencies..."
cd "$APP_DIR"
npm install --omit=dev --silent
echo "   Dependencies installed"

# ─── 7. Nginx ────────────────────────────────────────────────────────────────
echo ""
echo "▶ [7/9] Configuring Nginx..."

# Temporarily serve plain HTTP so certbot can get a cert
cat > /etc/nginx/sites-available/"$DOMAIN".conf << 'NGINX_HTTP_ONLY'
server {
    listen 80;
    listen [::]:80;
    server_name clipper.iceposeidon.network;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        proxy_pass http://127.0.0.1:4242;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX_HTTP_ONLY

ln -sf /etc/nginx/sites-available/"$DOMAIN".conf /etc/nginx/sites-enabled/"$DOMAIN".conf
mkdir -p /var/www/certbot

# Remove default site if present
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx || systemctl start nginx

# ─── 8. PM2 start ────────────────────────────────────────────────────────────
echo ""
echo "▶ [8/9] Starting app with PM2..."
cd "$APP_DIR"
pm2 delete clipper 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash || true   # register PM2 as system service

echo "   Waiting for app to be ready..."
sleep 3
if curl -sf http://127.0.0.1:4242/ > /dev/null; then
    echo "   ✓ App is responding on :4242"
else
    echo "   ✗ App did not respond — check: pm2 logs clipper"
fi

# ─── 9. SSL via Let's Encrypt ────────────────────────────────────────────────
echo ""
echo "▶ [9/9] Obtaining SSL certificate for $DOMAIN..."
echo "   (DNS for $DOMAIN must already point to this server)"

certbot --nginx \
    -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --redirect

# Now drop the full HTTPS config in place
cp "$SCRIPT_DIR/$DOMAIN.conf" /etc/nginx/sites-available/"$DOMAIN".conf
nginx -t && systemctl reload nginx

echo ""
echo "════════════════════════════════════════════════════"
echo "  ✓ Deploy complete!"
echo ""
echo "  Site:    https://$DOMAIN"
echo "  Direct:  http://204.13.232.252:4242"
echo "  App dir: $APP_DIR"
echo ""
echo "  Useful commands:"
echo "    pm2 logs clipper       — live logs"
echo "    pm2 restart clipper    — restart app"
echo "    pm2 monit              — CPU / memory dashboard"
echo "    nginx -t && systemctl reload nginx"
echo "════════════════════════════════════════════════════"
