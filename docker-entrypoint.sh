#!/usr/bin/env bash
# docker-entrypoint.sh — fix ownership of Docker-managed volumes, then drop
# from root to the unprivileged `clipper` user before starting the app.
#
# Named volumes (clipper-db, clipper-clips, clipper-temp, clipper-logs) are
# created root-owned by the Docker engine on first run, which would block
# writes once the process runs as `clipper` (see Dockerfile USER directive).
# This script runs once as root at container start purely to fix that, then
# hands off to `clipper` for everything else — the node process itself
# never runs as root.
set -euo pipefail

chown -R clipper:clipper /app /app/public/clips /app/temp /app/logs /app/backups /app/.staging 2>/dev/null || true

exec gosu clipper "$@"
