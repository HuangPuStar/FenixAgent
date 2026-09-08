#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT=$(bun -e 'process.stdout.write(process.env.RCS_PORT ?? "3000")')
PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  echo "Stopping server on port $PORT..."
  while IFS= read -r pid; do
    kill "$pid"
  done <<< "$PIDS"
fi

bun run build:web
exec bun run dev
