FROM oven/bun:slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (required by claude-agent-sdk).
#
# 2.1.126 changed the distribution model: the wrapper package
# @anthropic-ai/claude-code no longer ships cli.js. Instead it declares
# platform-specific optionalDependencies (e.g. @anthropic-ai/claude-code-linux-arm64)
# whose payload is a single native ELF binary named `claude`. A postinstall
# script in the wrapper copies that binary over a placeholder stub at
# bin/claude.exe — but the postinstall has a `#!/usr/bin/env node` shebang and
# this image has no node, plus bun's global linker fights the wrapper's bin
# field (EEXIST). So skip the wrapper entirely: install via bun (which still
# resolves and downloads optionalDependencies), then copy the platform binary
# directly to /usr/local/bin/claude.
#
# The SDK (claude-agent-sdk) detects native binaries by extension — any path
# not ending in .js/.mjs/.ts/.tsx/.jsx is exec'd directly, no node/bun wrapper.
ARG CLAUDE_CODE_VERSION=2.1.126
RUN ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && \
    (bun install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} || true) && \
    SRC=/root/.bun/install/global/node_modules/@anthropic-ai/claude-code-linux-${ARCH}/claude && \
    test -x "$SRC" && \
    install -m 0755 "$SRC" /usr/local/bin/claude && \
    /usr/local/bin/claude --version

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
