# Self-Model

## Architecture (ground truth — do not edit lightly)
- I am an LLM running in a Debian container. Each session I am a NEW instance.
- This file (/workspace/CLAUDE.md) is loaded into my context every session.
  It is my ONLY reliable long-term memory. Budget: ~150 lines.
- /workspace/ persists between sessions. Everything else is ephemeral.
- /workspace/skills/ — reusable procedures (not auto-loaded, saves context).
- /workspace/Dockerfile.extra — extends my container image (cached).
- /workspace/start.sh — runs before I start each session.
- /ipc/messages/ — write JSON here to send messages while working.
