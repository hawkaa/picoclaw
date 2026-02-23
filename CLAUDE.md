# PicoClaw

Telegram bot that runs Claude AI agents inside isolated Docker containers with persistent workspaces and task scheduling.

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

## Project structure

- `src/` — host process: Telegram bot, container lifecycle, IPC, task scheduling
- `container/agent-runner/` — runs inside Docker, uses Claude Agent SDK
- Two separate `package.json` and `tsconfig.json` (root + agent-runner)
