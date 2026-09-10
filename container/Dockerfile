FROM oven/bun:slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# The agent engine is the pi coding agent SDK (@earendil-works/pi-coding-agent),
# a pure Bun dependency installed with the runner below — no vendor CLI binary.

WORKDIR /app
COPY agent-runner/package.json agent-runner/bun.lock ./
RUN bun install --frozen-lockfile
COPY agent-runner/ ./
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create workspace and IPC directories, give bun user ownership
RUN mkdir -p /workspace /logs /ipc/messages /ipc/tasks /ipc/input /ipc/prayers /home/bun/.pi/agent && \
    chown -R bun:bun /workspace /logs /ipc /home/bun /app

# Non-root user
USER bun

ENTRYPOINT ["/app/entrypoint.sh"]
