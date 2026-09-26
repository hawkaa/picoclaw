# PicoClaw

Telegram bot that runs AI agents (pi coding agent) inside isolated Docker containers with persistent workspaces and task scheduling.

## Tooling

- **Runtime**: Bun. Never use `npx` or `bunx`.
- `bun run check` — TypeScript type checking
- `bun run lint` — Biome linting
- `bun run lint:fix` — Biome auto-fix
- `bun run test` — Bun test runner

## TypeScript conventions

Strict tsconfig with these notable settings:

- `verbatimModuleSyntax` — use `import type` for type-only imports
- `exactOptionalPropertyTypes` — optional props need `?: T | undefined`, not `?: T`
- `noPropertyAccessFromIndexSignature` — use `process.env["KEY"]` not `process.env.KEY`
- `noUncheckedIndexedAccess` — array/object indexing returns `T | undefined`
- Node.js builtins use `node:` protocol (`import fs from "node:fs"`)

## Deployment

- **Service**: `systemctl restart picoclaw` — host process runs as a systemd unit
- **Docker image**: `container/build.sh` — rebuilds `picoclaw-base:latest`
- Changes to `src/` require service restart; changes to `container/agent-runner/` require image rebuild + restart
- Per-chat images (`picoclaw-<chat>:latest`, from a workspace `Dockerfile.extra`) rebuild automatically on the next spawn after the base changes; that first message waits several minutes

## Adding or switching a model

New models regularly break in ways unit tests can't catch. Do every step:

1. **Alias**: add it to `MODEL_ALIASES` in `src/config.ts`. Update `DEFAULT_MODEL` / `DEFAULT_INTERACTIVE_MODEL` if the default changes. Anthropic ids that pi's catalog doesn't know are cloned from `ANTHROPIC_CLONE_TEMPLATES` in `container/agent-runner/src/resolve-pi-model.ts`. Add a closer template if the context window or max tokens differ.
2. **Claude Code version floor**: Anthropic runs over a Claude Code OAuth token, and pi-ai presents itself as a pinned Claude Code version. New models can require a newer one; when the pinned version is too old, every turn fails with `claude_code_version_too_old`. Check the pinned version:
   `grep -o 'claudeCodeVersion = "[0-9.]*"' container/agent-runner/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`
   If in doubt, bump in `container/agent-runner`: `bun add @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest`.
3. **Commit** `container/agent-runner/package.json` + `bun.lock` with the alias change. A dependency bump left uncommitted on the host gets reverted by the next stash/pull.
4. **Deploy**: `bash container/build.sh`, then `systemctl restart picoclaw`.
5. **Verify what actually runs**, not just the repo:
   - Every image in use carries the new version:
     `docker run --rm --entrypoint sh <image> -c 'grep -rhoE "claudeCodeVersion=\"[0-9.]+\"" /app/node_modules/@earendil-works | sort -u'` for `picoclaw-base:latest` and each `picoclaw-<chat>:latest`.
   - In Telegram: `/new <alias>`, send a message, and get a real reply rather than `Agent error: 400`.

## Project structure

- `src/` — host process: Telegram bot, container lifecycle, IPC, task scheduling
- `container/agent-runner/` — runs inside Docker, uses `@earendil-works/pi-coding-agent`
- Two separate `package.json` and `tsconfig.json` (root + agent-runner)
