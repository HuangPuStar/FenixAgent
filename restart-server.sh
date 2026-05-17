#!/usr/bin/env bash
set -euo pipefail

for port in 3000 $(seq 8888 8900); do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing port $port (PIDs: $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  else
    echo "Port $port is free"
  fi
done

bun run build:web

echo ""
echo "Starting server..."
bun run dev
