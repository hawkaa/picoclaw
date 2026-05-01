# PicoClaw

Minimal infrastructure for running Claude agents persistently, in isolation, over time.

## What it is

PicoClaw is a Bun/TypeScript host that manages Claude agent sessions in Docker containers. Each session gets an ephemeral container with an isolated filesystem and no access to the host except what's explicitly mounted. The agent has a real working directory that persists across sessions, a scheduler that runs it on cron without human invocation, and memory that compounds between runs.

The agent loop itself is small. The container boundary, the workspace persistence, the scheduler, the IPC layer — that's what PicoClaw is.

## Core capabilities

**Isolation**  
Each session runs in a fresh container with its own filesystem and PID namespace. API keys are passed via stdin and immediately unset. A misunderstood task or a malformed tool call doesn't reach your host.

**Persistent workspace**  
`/workspace` mounts as a persistent volume. `CLAUDE.md` loads every session. Skills accumulate. After each session, the workspace is auto-committed to a git repo. Full history, always recoverable.

**Scheduler**  
The host process checks every 60 seconds and spawns containers on cron, interval, or one-time schedules. Agents can register their own future tasks. Self-scheduling is what separates autonomous from interactive.

**IPC**  
Agents can send Telegram messages while working, not just at the end. The host injects follow-up messages from Telegram into a running session. Agents write task files to `/ipc/tasks/` and the scheduler picks them up.

**Working memory**  
Reflections, patterns, and knowledge are stored in a Turso SQLite database (queryable, persistent, agent-writable). Patterns compound between sessions.

**Identity**  
Each session is issued an EdDSA JWT (`$AGENTLAIR_AAT`) with a 1-hour TTL, verifiable via JWKS. Agents authenticate to external services using this token — the host API key never enters the container.

## Architecture

```
Host process (Bun)
├── Telegram bot
├── Task scheduler  →  spawns containers
├── IPC watcher     →  injects messages into running sessions
└── Workspace git   →  auto-commits after each session

Container (agent session)
├── Claude Agent SDK
├── /workspace (persistent volume)
├── /ipc (messaging)
└── ~/.claude/ (session transcripts)
```

Reference: `memory/knowledge/picoclaw-architecture.md` (inside the workspace).

## Setup

1. Copy `.env.example` to `.env` and fill in credentials
2. Build the container image: `bash container/build.sh`
3. Start the host: `bun run start`
4. Create a Telegram bot, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

The agent will load `CLAUDE.md` from whatever directory is mounted as `/workspace`.

## Why not a shell script?

The agent loop fits in a few hundred lines of shell. Tool dispatch, API calls, context trimming — that's small.

What changes when you want agents running unsupervised at 3am: you need isolation so the agent can't reach the host, persistence so it has a home between runs, a scheduler so it can act without you invoking it, and memory so it isn't starting from zero each time. None of that fits in a single script. PicoClaw is that hardening, built as infrastructure rather than UI.

## Status

Early. Used in production for autonomous agent sessions. Breaking changes likely.
