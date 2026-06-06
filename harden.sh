#!/usr/bin/env bash
# harden.sh — SSH brute-force & Nginx protection for 204.13.232.252
# Run as root AFTER deploy.sh, or standalone on any Ubuntu/Debian server
set -euo pipefail

echo "════════════════════════════════════════════════════"
echo "  Fail2ban + UFW Hardening"
echo "════════════════════════════════════════════════════"

# ─── 1. Install ───────────────────────────────────────────────────────────────
echo ""
echo "▶ [1/5] Installing fail2ban & ufw..."
apt-get update -qq
apt-get install -y -qq fail2ban ufw

# ─── 2. Fail2ban — jail.local ─────────────────────────────────────────────────
echo ""
echo "▶ [2/5] Writing /etc/fail2ban/jail.local..."
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
# Ban for 1 hour after hitting threshold
bantime  = 3600
# Look back 10 minutes
findtime = 600
# Allow 5 failures before banning
maxretry = 5
# Ignore localhost and your own IP (add yours here)
ignoreip = 127.0.0.1/8 ::1
# Use iptables
banaction = iptables-multiport

# ── SSH ───────────────────────────────────────────────────────────────────────
[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 5
bantime  = 3600

# ── Nginx: too many requests (rate-limited 4xx) ───────────────────────────────
[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
port     = http,https
logpath  = /var/log/nginx/*.error.log
maxretry = 10
bantime  = 600

# ── Nginx: 404/bad bots hammering unknown paths ───────────────────────────────
[nginx-botsearch]
enabled  = true
filter   = nginx-botsearch
port     = http,https
logpath  = /var/log/nginx/*.access.log
maxretry = 15
bantime  = 3600

# ── Nginx: basic auth brute force ─────────────────────────────────────────────
[nginx-http-auth]
enabled  = true
filter   = nginx-http-auth
port     = http,https
logpath  = /var/log/nginx/*.error.log
maxretry = 5
bantime  = 3600
EOF

# ─── 3. Custom filter — Nginx 4xx flood ───────────────────────────────────────
echo ""
echo "▶ [3/5] Writing custom nginx-4xx filter..."
cat > /etc/fail2ban/filter.d/nginx-4xx.conf << 'EOF'
[Definition]
# Catch any client generating lots of 4xx responses (scanners, bad bots)
failregex = ^<HOST> .+ "(GET|POST|HEAD|PUT|DELETE|OPTIONS).+" (4\d\d) \d+
ignoreregex =
EOF

# Add it to jail.local
cat >> /etc/fail2ban/jail.local << 'EOF'

# ── Nginx: generic 4xx flood ──────────────────────────────────────────────────
[nginx-4xx]
enabled  = true
filter   = nginx-4xx
port     = http,https
logpath  = /var/log/nginx/clipper.access.log
maxretry = 30
findtime = 60
bantime  = 1800
EOF

# ─── 4. UFW firewall ──────────────────────────────────────────────────────────
echo ""
echo "▶ [4/5] Configuring UFW..."
ufw --force reset

# Default: deny in, allow out
ufw default deny incoming
ufw default allow outgoing

# Allow SSH (critical — do this before enabling!)
ufw allow ssh

# Allow HTTP + HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# Allow direct Node access on :4242 ONLY from localhost
# (Nginx proxies externally — no need to expose 4242 publicly)
ufw deny 4242/tcp

# Enable without prompt
ufw --force enable
ufw status verbose

# ─── 5. Start & enable fail2ban ───────────────────────────────────────────────
echo ""
echo "▶ [5/5] Enabling fail2ban..."
systemctl enable fail2ban
systemctl restart fail2ban
sleep 2

# Show active jails
fail2ban-client status

echo ""
echo "════════════════════════════════════════════════════"
echo "  ✓ Hardening complete!"
echo ""
echo "  Useful commands:"
echo "    fail2ban-client status sshd        — SSH ban list"
echo "    fail2ban-client status nginx-4xx   — Nginx ban list"
echo "    fail2ban-client set sshd unbanip <IP>  — unban an IP"
echo "    ufw status verbose                 — firewall rules"
echo "    cat /var/log/fail2ban.log          — fail2ban log"
echo ""
echo "  ⚠  If you change SSH port from 22, update ufw:"
echo "     ufw allow <port>/tcp && ufw delete allow ssh"
echo "════════════════════════════════════════════════════"