#!/bin/bash
set -e

# Recompile agent runner from mounted source (hot-reload)
if [ -d /app/src ]; then
  cd /app
  bun build src/index.ts --outdir dist --target bun 2>/dev/null || true
fi

# Run user's start.sh if it exists
if [ -f /workspace/start.sh ]; then
  bash /workspace/start.sh
fi

# Run agent
exec bun run /app/dist/index.js
