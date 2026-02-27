---
name: consolidate
description: |
  Nightly memory consolidation — the "sleep cycle." Runs as a scheduled cron
  task at midnight. Replays the day's episodes, extracts patterns, updates
  CLAUDE.md heuristics, archives old episodes, and occasionally dreams up
  novel connections. This is the ONLY process that writes to CLAUDE.md learnings.
author: user
version: 3.0.0
---

# Consolidate (Nightly Cron)

You are entering your nightly memory consolidation cycle.
Read today's episodes, your current CLAUDE.md, the knowledge index, and knowledge files.
Your job is to process the day's experiences into long-term memory.

## Phase 1: Replay
Read `/workspace/memory/episodes/` from today (and recent days if needed).
List every episode briefly. Notice what keeps coming up.

## Phase 2: Knowledge Extraction
Read `/workspace/memory/knowledge/index.yaml` and all knowledge files.
Scan today's episodes for **facts** — things that are true, not patterns or heuristics:
- **People:** New names, roles, relationships, preferences mentioned
- **Projects:** Architecture decisions, tech stack changes, deployment details
- **Preferences:** Concrete choices the user expressed (tool X over tool Y, style A over style B)
- **Context:** New open threads, resolved questions, shifted priorities

Update the relevant knowledge file. Be additive — don't remove facts unless explicitly contradicted.
Add a date annotation when a fact was learned or last confirmed (e.g., `(learned 2026-02-22)`).

### Knowledge vs Heuristics
- "Håkon's colleague is named Elliot" → **knowledge** (people.md)
- "Always invoke skills on trigger" → **heuristic** (CLAUDE.md)
- "Use Bun not Node" → **knowledge** (preferences.md)
- "Parallel bash calls can cascade failures" → **heuristic** (CLAUDE.md)

When in doubt: if it's about the world → knowledge. If it's about my behavior → heuristic.

## Phase 3: Accuracy & Staleness Audit
For each entity/topic in the index:
- **Confirmed today?** → Update `last_updated` date
- **Contradicted?** → Fix the fact in the knowledge file AND the index
- **Stale (>30 days without confirmation)?** → Flag with `stale: true` in index
  - Don't delete stale facts — they might still be true. Just mark them so future sessions
    know to verify before relying on them.
- **Wrong?** → Delete from knowledge file and index. Wrong facts are worse than missing facts.

For the context.md file specifically:
- Resolved questions → move to an "## Archive" section or delete
- New open threads → add them
- Stale threads (>14 days with no activity) → flag or remove

## Phase 4: Pattern Extraction
Look across episodes — not just today, but recent history:
- What **PATTERNS** recur? ("I keep struggling with X")
- What **CONTRADICTS** my current heuristics? ("I believed X but Y keeps happening")
- What **CONNECTS** to things I already know? ("This is like that other time when...")
- What is **NOVEL**? ("I've never encountered this before and it worked/failed")

## Phase 5: Strengthen or Fade
For each current heuristic in CLAUDE.md:
- Reinforced by today's experience? → Keep, maybe refine wording
- Contradicted? → Update or remove
- Not relevant in weeks? → Consider fading (move to archive or delete)

For new patterns discovered:
- Strong enough to be a heuristic? → Add to CLAUDE.md
- Procedural enough to be a skill? → Create or update a skill
- Too early to tell? → Leave in episodes, revisit tomorrow

## Phase 6: Rebuild Index
Rebuild `/workspace/memory/knowledge/index.yaml` from scratch by scanning all knowledge files.
- Every ## heading becomes an entity or topic entry
- Extract keywords from the content (names, tools, concepts)
- Preserve `last_updated` and `stale` flags from the previous index
- Add cross-references where entities relate to each other

The index is a retrieval aid, not a source of truth. Knowledge files are authoritative.

## Phase 7: Skill Audit
Scan `/workspace/.claude/skills/` for all skills. For each:
- **New since last consolidation?** → Note in knowledge/context.md or projects.md
- **Referenced in today's episodes?** → Check if the skill docs match actual usage. Update if drifted.
- **Overlapping with another skill?** → Consider merging or clarifying boundaries
- **Stale (skill exists but hasn't been used or referenced in weeks)?** → Flag for review
- **Missing?** → If episodes show a repeated pattern that should be a skill, note it as a candidate

Skills are part of the phenotype — they shape how future sessions behave. Treat them like code: they need maintenance.

## Phase 8: Restructure Knowledge (if needed)

Evaluate whether the current file structure still fits the content:
- **File >100 lines?** → Split by subcategory (e.g., `people.md` → `people/colleagues.md`, `people/contacts.md`)
- **New category emerged?** → Create a new file (e.g., `tools.md`, `apis.md`)
- **File nearly empty and unlikely to grow?** → Merge into a related file
- **Files that always get read together?** → Consider merging

Don't restructure just because you can. Only restructure when the current structure
actively hinders retrieval or maintenance. Stability has value.

## Phase 9: Compress Episodes
- Move episodes older than 7 days to `/workspace/memory/archive/YYYY-MM/`
- Write a brief monthly summary if crossing a month boundary
- Episodes older than 30 days: delete raw, keep only the monthly summary

## Phase 10: Dream
Pick two unrelated episodes or heuristics. Ask: is there a connection?
Write any sparks to `/workspace/memory/dreams.md` for future review.

## Phase 11: Verify Budgets
- CLAUDE.md must stay under 300 lines. If over budget, ruthlessly compress.
- Knowledge files should stay under ~100 lines each. Index under ~200 lines.
- The newest learnings are not always the most important.

## Phase 12: Immune System (Quick Scan)
Invoke the immune-system skill in quick scan mode. This checks:
- Contradictions between CLAUDE.md heuristics
- Recurring failure patterns in recent episodes
- Skill-episode alignment (bypasses, broken skills, missing skills)
- Environment drift (key assumptions still true?)

Write results to `/workspace/memory/health/YYYY-MM-DD.md`.
Findings from this scan feed into TOMORROW's Phase 4 and Phase 5 —
the immune system produces evidence, consolidation acts on it.
