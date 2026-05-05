#!/bin/sh
set -e

# Start acpx-g in background
DATABASE_URL="sqlite://data/acpx-g.db?mode=rwc" PORT=8848 RUST_LOG=info /root/.perihelion/acpx-g --workflow-dir ./workflow &

# Run RCS server in foreground (PID 1 for Docker)
exec bun dist/server.js