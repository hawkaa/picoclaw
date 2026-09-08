#!/bin/bash
set -e

TAG="${1:-latest}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

docker build -t "picoclaw-base:${TAG}" "$SCRIPT_DIR"

# Reusing the tag leaves the previous base image untagged, and nothing reclaims
# it later. Only dangling images are removed here.
docker image prune -f

echo ""
echo "Built picoclaw-base:${TAG}"
echo "Test with: docker run --rm -it picoclaw-base:${TAG} bash"
