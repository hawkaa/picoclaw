FROM oven/bun:slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (required by claude-agent-sdk)
RUN bun install -g @anthropic-ai/claude-code && \
    cp -r /root/.bun/install/global/node_modules/@anthropic-ai/claude-code /usr/local/lib/claude-code && \
    chmod -R a+rX /usr/local/lib/claude-code

WORKDIR /app
COPY agent-runner/package*.json ./
RUN bun install
COPY agent-runner/ ./
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create workspace and IPC directories, give bun user ownership
RUN mkdir -p /workspace /logs /ipc/messages /ipc/tasks /ipc/input /ipc/prayers /home/bun/.claude/projects/-workspace /home/bun/.claude/debug && \
    chown -R bun:bun /workspace /logs /ipc /home/bun /app

# Non-root user (required for --dangerously-skip-permissions)
USER bun

ENTRYPOINT ["/app/entrypoint.sh"]
