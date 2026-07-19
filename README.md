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

**Per-task secret injection**  
A task or cron can declare host-held secrets it needs (`"secrets": ["OPENROUTER_API_KEY"]`); the host injects them as env vars into that session only. It is opt-in per task, gated by a host-side whitelist (`injectable-secrets.json`), and audited by name. See below.

## Injectable secrets

Sessions normally receive only the fixed harness secrets (model auth, `AGENTLAIR_AAT`). A task that needs an extra host-held secret — e.g. `OPENROUTER_API_KEY` for an in-session inference call — declares it:

```json
{ "type": "schedule", "label": "inference-task", "prompt": "...",
  "schedule_type": "cron", "schedule_value": "0 9 * * *",
  "secrets": ["OPENROUTER_API_KEY"] }
```

The host resolves each declared name against a whitelist and injects the value as an env var into that container's session (via the same stdin channel the harness keys use). Copy `injectable-secrets.example.json` to `injectable-secrets.json` (gitignored) and map each allowed name to its source:

```json
{
  "OPENROUTER_API_KEY": { "env": "OPENROUTER_API_KEY" },
  "BRAVE_API_KEY": "BRAVE_SEARCH_KEY",
  "SOME_SERVICE_TOKEN": { "file": "/home/user/.secrets/some_service_token" }
}
```

An entry maps a name to `{ "env": "VAR" }`, `{ "file": "/path" }`, or the shorthand `"VAR"` (env). Paths default to `injectable-secrets.json` and `data/secret-injections.jsonl` beside the process; override with `PICOCLAW_INJECTABLE_SECRETS_FILE` / `PICOCLAW_SECRET_AUDIT_LOG`.

**Threat model.** Containers run agent-authored code, so the injection path is deliberately narrow:

- **Opt-in per task.** Only names a task lists in `secrets` are considered; a task that declares nothing gets nothing beyond the harness set.
- **Whitelisted host-side.** The task author names a secret; the *host* alone decides whether — and from where — it resolves. A name absent from the whitelist is a **hard spawn error (fail closed)**, never a silent skip, so a typo or an unauthorized name aborts the run rather than starting with a partial secret set. Resolution happens *before* the container spawns, so a rejection leaves no orphaned process.
- **Reserved names are unreachable.** Harness-managed keys (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `MAX_THINKING_TOKENS`, `AGENTLAIR_AAT`) can never be injected, even if the whitelist mistakenly lists one — a task cannot hijack its own auth, model, or routing.
- **Audited by name only.** Every injection appends `{ts, chatId, taskId, label, names[]}` to the audit log. **Values are never logged.**

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
