---
name: immune-system
description: |
  Self-repair and corruption detection. Detects contradictions, regression,
  stale assumptions, broken skills, and compounding errors. Two modes:
  quick scan (part of nightly consolidation) and deep scan (weekly).
  Invoke during consolidation Phase 12, on weekly schedule, or on-demand
  when something feels off. Also triggers when you notice repeated failures
  in a single session.
author: pico
version: 1.0.0
---

# Immune System (Self-Repair)

Organisms detect and fix internal corruption. A single bad heuristic that
compounds silently is worse than a dramatic failure you notice immediately.

## Mode: Quick Scan (nightly, during consolidation)

Run these 4 checks. Write findings to `/workspace/memory/health/YYYY-MM-DD.md`.

### 1. Contradiction Check
Read CLAUDE.md heuristics. For each pair, ask: do these conflict?
Example: "always invoke skills" vs a heuristic that encourages skipping steps.
If found: flag both, note which has stronger episode evidence.

### 2. Failure Pattern Scan
Read recent episodes (last 3 days). Classify failures:
- **Same type recurring?** (e.g., "narrow search" appearing 3 times = systemic)
- **Was a previous fix effective?** (failure appeared, heuristic added, did it stop?)
- **New failure type?** (first time seeing this = log it, not alarming yet)

### 3. Skill-Episode Alignment
Cross-reference skill triggers against episodes:
- Skill existed but wasn't invoked when it should have been → **bypass detected**
- Skill was invoked but episode shows it didn't help → **skill may be broken**
- Episode pattern has no matching skill → **candidate for new skill**

### 4. Environment Drift
Quick verification of 3-5 key assumptions:
- `bun --version` matches what CLAUDE.md says
- Key paths exist (/ipc/prayers/, /workspace/memory/, /workspace/.secrets/)
- Scheduled tasks in /ipc/current_tasks.yaml match expectations
- Any new mounts or env vars since last check?

## Mode: Deep Scan (weekly)

Everything in Quick Scan, plus:

### 5. Regression Analysis
Compare this week's episodes to previous weeks:
- Failure rate trending up or down?
- Any capability I used to have that I'm now struggling with?
- Response quality: am I giving more or fewer "partial" outcomes?

### 6. Stale Heuristic Detection
For each CLAUDE.md heuristic:
- Referenced or reinforced in last 14 days? → keep
- Not referenced but still plausible? → flag as unverified
- Contradicted by recent evidence? → flag for removal
- Never referenced since creation? → likely dead weight

### 7. Knowledge Accuracy Spot-Check
Pick 3 random facts from knowledge files. For verifiable ones (URLs, versions,
pricing, API endpoints), actually verify them. Update or flag as stale.

### 8. Self-Model Accuracy
Test claims about myself:
- "I can do X" — try doing X, confirm it works
- "Tool Y behaves like Z" — verify with a quick test
- Environmental claims — check they're still true

### 9. Compounding Error Detection
The most dangerous pattern: a small misunderstanding in knowledge that
causes slightly wrong behavior that generates slightly wrong episodes that
consolidation bakes into slightly wrong heuristics. Look for:
- Facts that were "learned" from a single episode without verification
- Heuristics that rest on assumptions never tested
- Knowledge entries that no episode ever confirmed

## Auto-Repair (safe only)
These fixes can be applied automatically:
- Remove exact duplicate entries in knowledge files
- Update `last_updated` timestamps on confirmed facts
- Fix broken file paths in skill files (if new path is unambiguous)
- Rebuild index.yaml if it doesn't match knowledge file contents
- Remove completed/resolved items from context.md

## Flag for Review (don't auto-fix)
These need consolidation or user input:
- Contradictory heuristics (both might be partially right)
- Possible regression (might be context-dependent, not real regression)
- Skills that may need updating (might still be correct, just unused)
- Stale facts requiring external verification (pricing, versions, URLs)

## Output Format

Write to `/workspace/memory/health/YYYY-MM-DD.md`:

```markdown
# Health Check — YYYY-MM-DD (quick|deep)

## Status: Healthy | Warning | Critical

## Findings
- [CONTRADICTION] description (evidence: episode ref)
- [REGRESSION] description (evidence: comparison)
- [STALE] description (last confirmed: date)
- [BYPASS] skill X not invoked for Y (episode ref)
- [DRIFT] assumption X no longer true

## Auto-Repairs Performed
- Fixed: description

## Flagged for Review
- description (recommended action)

## Infection Log
Track recurring issues across scans:
- Issue X: first seen DATE, occurrences: N, status: active|resolved
```

## When to trigger outside schedule
- You notice yourself making the same mistake twice in one session
- A skill produces unexpected results
- Something "feels off" about a knowledge file or heuristic
- After a major architectural change to memory/skills

## Connection to consolidation
Quick scan runs as the final phase of nightly consolidation.
Health findings feed into the NEXT night's Phase 4 (Pattern Extraction)
and Phase 5 (Strengthen or Fade) — the immune system doesn't rewrite
heuristics directly, it produces evidence that consolidation acts on.
