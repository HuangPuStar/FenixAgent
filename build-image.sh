#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="rcs"
IMAGE_TAG="latest"
PLATFORM="linux/amd64"
OUTPUT_FILE="rcs-amd64.tar.gz"

while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    -o|--output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [-t tag] [-o output.tar.gz]"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=> Building frontend..."
bun run build:web

echo "=> Building ${IMAGE_NAME}:${IMAGE_TAG} for ${PLATFORM}..."

# Ensure buildx builder with docker-container driver and registry mirror
BUILDER="rcs-builder"
if ! docker buildx inspect "$BUILDER" &>/dev/null; then
  echo "=> Creating buildx builder: ${BUILDER}"
  docker buildx create \
    --name "$BUILDER" \
    --driver docker-container \
    --driver-opt network=host \
    --config "${SCRIPT_DIR}/buildkitd.toml" \
    --use
else
  docker buildx use "$BUILDER"
fi

# Temporarily swap .dockerignore to include web/dist for cross-platform build
cp "${SCRIPT_DIR}/.dockerignore" "${SCRIPT_DIR}/.dockerignore.bak"
cp "${SCRIPT_DIR}/.dockerignore.amd64" "${SCRIPT_DIR}/.dockerignore"
trap 'mv "${SCRIPT_DIR}/.dockerignore.bak" "${SCRIPT_DIR}/.dockerignore" 2>/dev/null' EXIT

docker buildx build \
  --platform "$PLATFORM" \
  --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
  --load \
  --file Dockerfile.amd64 \
  .

# Restore original .dockerignore
mv "${SCRIPT_DIR}/.dockerignore.bak" "${SCRIPT_DIR}/.dockerignore"

echo "=> Compressing to ${OUTPUT_FILE}..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "${OUTPUT_FILE}"

FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo ""
echo "=> Done! Image saved to ${OUTPUT_FILE} (${FILE_SIZE})"
echo ""
echo "To load on target machine:"
echo "  gunzip -c ${OUTPUT_FILE} | docker load"
echo "  docker run -d -p 3000:3000 ${IMAGE_NAME}:${IMAGE_TAG}"
