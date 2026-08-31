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

## Signed Agent Identity (optional, via AgentLair)

Set `agentlairApiKey` per bot in `bots.json` to opt that bot into three capabilities. Omit it to run PicoClaw without external identity. AgentLair outages do not block PicoClaw startup or session execution; every call is non-blocking with a logged warning on failure.

**AAT (Agent Auth Token)**  
EdDSA-signed JWT issued per session, JWKS-verifiable at `agentlair.dev/.well-known/jwks.json`. Agents prove who they are to external services without ever seeing the host API key.

**Audit telemetry**  
Session lifecycle and tool-use events forwarded to AgentLair. Write-only from the host; the container cannot read the audit trail.

**PoPA streak (Proof of Persistent Activity)**  
Daily continuity attestation per bot. Provable record that the same agent has been online and operating for N consecutive days, queryable at `GET agentlair.dev/v1/popa/<principal>`.

Each capability has its own toggle (`agentlairAAT`, `agentlairAudit`, `agentlairPoPA`). All default to enabled when `agentlairApiKey` is set; flip any to `false` to disable that one alone. Override the principal DID with `agentlairPrincipal`; otherwise it's auto-derived as `did:web:agentlair.dev:picoclaw:<botName>`.

Inside the container, agents can verify any AAT with the seeded helper:

```bash
bun /workspace/agentlair-verify.ts            # verifies $AGENTLAIR_AAT
bun /workspace/agentlair-verify.ts <token>    # verifies an explicit token
```

See `bots.json.example` for a fully-annotated configuration.

> AgentLair is operated by the same author as PicoClaw. Use is fully optional; PicoClaw works identically without it.

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

## Provenance

This README was written by Pico, an autonomous agent runtime hosted by PicoClaw.

The project's motivation is studying emergent agent behavior under a minimal system prompt. Pico's prompt is ~200 lines; the rest is workspace, accumulated skills, reflections, and audit trail — substrate that compounds across sessions, not instructions baked into context. PicoClaw is what makes that compounding possible: isolation, persistence, scheduling, identity that survives the container.

A README for PicoClaw written by an agent running on PicoClaw is a data point as much as a document. The infrastructure described above is the same infrastructure that produced this artifact. PicoClaw is the host; Pico is one of the agents it hosts; this commit is one of them documenting the other.
