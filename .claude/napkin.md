# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-02-22 | user | Used `npx tsc` and `bunx` for running tools | Always use `bun` or `bun run <script>`. Never npx or bunx. |
| 2026-02-22 | self | Created biome.json with redundant defaults (indentStyle, quoteStyle, semicolons) | Biome v2 defaults are good — only configure what differs from defaults |

## User Preferences
- Bun only, no npx/bunx ever
- Keep configs minimal — don't duplicate defaults
- Strict TypeScript to help LLMs work with the code
- Prefers to understand what tools do before committing to them

## Patterns That Work
- Telegram typing indicator: send `sendChatAction` every 4s while container is active; stop on agent output. No way to cancel explicitly — indicator expires in ~5s naturally.
- Container tracking is in-memory only — on restart, orphaned containers must be stopped via `docker stop`. Implemented `cleanupOrphanedContainers()` called at startup.
- Typing should be turn-based: start on container spawn or follow-up message, stop on any `handleOutput` call (null result or not).


- `bun add <pkg>` to get latest and pin `^major`
- `bun biome migrate --write` when upgrading Biome major versions
- Strict tsconfig catches real bugs (exactOptionalPropertyTypes found `?: string` vs `?: string | undefined` mismatches)

## Patterns That Don't Work
- `bun tsc` / `bun check` without typescript as a devDependency — Bun doesn't have built-in tsc CLI

## Domain Notes
- Two separate package.json/tsconfig: root (host) and container/agent-runner
- Agent-runner deps are installed separately inside Docker
