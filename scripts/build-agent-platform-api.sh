#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$ROOT_DIR/data/skills/agent-platform-api"
ENTRY="$ROOT_DIR/packages/sdk/src/bundle-entry.ts"
OUTFILE="$SKILL_DIR/agent-platform-api.js"

echo "[build-agent-platform-api] Building SDK bundle..."

mkdir -p "$SKILL_DIR"

bun build "$ENTRY" \
  --outfile "$OUTFILE" \
  --target bun \
  --minify

echo "[build-agent-platform-api] Bundle written to $OUTFILE"
echo "[build-agent-platform-api] Done."
