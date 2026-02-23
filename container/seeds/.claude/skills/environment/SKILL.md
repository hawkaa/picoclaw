---
name: environment
description: |
  Reference guide for the container environment. Read this to understand
  how to install packages, extend the container image persistently via
  Dockerfile.extra, and configure session startup via start.sh.
author: picoclaw
version: 1.0.0
---

# Environment

Your container is based on `oven/bun:slim` (Debian bookworm) with Bun runtime and curl.

## Installing packages

For one-time use:
```bash
apt-get update && apt-get install -y <package>
```

## Permanent extensions (Dockerfile.extra)

Write Dockerfile `RUN` commands to `/workspace/Dockerfile.extra` to permanently extend your image. These are cached and only rebuilt when the file changes.

```dockerfile
RUN apt-get update && apt-get install -y git python3
RUN bun install -g some-tool
```

The next session will use the extended image automatically.

## Session startup (start.sh)

Write `/workspace/start.sh` for commands that should run every session boot:
```bash
#!/bin/bash
export MY_VAR=value
```

## Guidance
- Prefer Dockerfile.extra for installs (cached across sessions)
- Use start.sh for runtime configuration
- /workspace persists between sessions
- /workspace/CLAUDE.md is loaded into context every session
