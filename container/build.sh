#!/bin/bash
set -e

TAG="${1:-latest}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

docker build -t "picoclaw-base:${TAG}" "$SCRIPT_DIR"

echo ""
echo "Built picoclaw-base:${TAG}"
echo "Test with: docker run --rm -it picoclaw-base:${TAG} bash"
