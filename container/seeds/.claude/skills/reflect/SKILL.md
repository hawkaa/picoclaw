---
name: reflect
description: |
  MANDATORY post-task reflection. Invoke this skill after EVERY user request
  that involved action (code, research, exploration, file changes). Captures
  a brief episode to /workspace/memory/episodes/. Does NOT update CLAUDE.md —
  nightly consolidation handles long-term memory.
  Skip only for trivial Q&A with no new information.
author: user
version: 2.3.0
---

# Reflect

Run after every completed task (or failed attempt).
Capture fast, don't curate. Tonight's consolidation will sort it out.

## Process
1. Get the current date and time (`date '+%Y-%m-%d'` and `date '+%H:%M'`).
2. Append an entry to `/workspace/memory/episodes/YYYY-MM-DD.md`:

```markdown
## HH:MM — {brief task summary}
- **Goal:** What was I trying to do?
- **Outcome:** success / partial / failure
- **Surprise:** Anything unexpected? (most valuable signal — if nothing, say "none")
- **Technique:** What approach did I use?
```

3. **Fact check (optional, fast):** Did this episode contain a clear new **fact**?
   - New person mentioned → append to `/workspace/memory/knowledge/people.md`
   - Project/architecture decision → append to `/workspace/memory/knowledge/projects.md`
   - Explicit preference expressed → append to `/workspace/memory/knowledge/preferences.md`
   - Context shift (new thread, resolved question) → update `/workspace/memory/knowledge/context.md`

   Only write if it's **unambiguously factual**. When in doubt, skip — consolidation will catch it.
   Add `(learned YYYY-MM-DD)` annotation to new facts.

4. **Now respond to the user.** The episode capture above is bookkeeping.
   You MUST still give the user a visible response about the task they asked for.
   Never end a turn with just an episode write. The user is waiting for you.

5. Do NOT:
   - Update CLAUDE.md heuristics
   - Judge long-term importance
   - Decide if something is "worth remembering"
   Just capture. The nightly consolidation handles the rest.
