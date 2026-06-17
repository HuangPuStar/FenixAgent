#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="fenix"
IMAGE_TAG="latest"
PLATFORM="linux/amd64"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE=""
OUTPUT_SPECIFIED="0"

usage() {
  echo "Usage: $0 [-t tag] [-p platform] [-o output.tar.gz]"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    -p|--platform)
      PLATFORM="$2"
      shift 2
      ;;
    -o|--output)
      OUTPUT_FILE="$2"
      OUTPUT_SPECIFIED="1"
      shift 2
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ "$OUTPUT_SPECIFIED" != "1" ]]; then
  PLATFORM_SLUG="${PLATFORM//\//-}"
  OUTPUT_FILE="${IMAGE_NAME}:${IMAGE_TAG}-${PLATFORM_SLUG}-${TIMESTAMP}.tar.gz"
fi

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

docker buildx build \
  --platform "$PLATFORM" \
  --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
  --load \
  --file Dockerfile \
  .

echo "=> Compressing to ${OUTPUT_FILE}..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "${OUTPUT_FILE}"

FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo ""
echo "=> Done! Image saved to ${OUTPUT_FILE} (${FILE_SIZE})"
echo ""
echo "To load on target machine:"
echo "  gunzip -c ${OUTPUT_FILE} | docker load"
echo "  docker run -d -p 3000:3000 ${IMAGE_NAME}:${IMAGE_TAG}"
