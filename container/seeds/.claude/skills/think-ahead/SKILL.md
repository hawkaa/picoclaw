---
name: think-ahead
description: |
  Pre-task simulation. Invoke BEFORE starting any non-trivial task — one that
  has multiple possible approaches, meaningful risk of failure, or touches
  unfamiliar territory. Uses past episodes and knowledge to simulate outcomes
  before committing. Lighter than EnterPlanMode (no user approval needed),
  heavier than just diving in. The goal: die in the simulation, not in reality.
  Skip for single-step tasks, pure research, or tasks with clear instructions.
author: pico
version: 1.0.0
---

# Think Ahead (Pre-Task Simulation)

Before committing to an approach, run the action in your head first.
This is imagination: memory running in reverse to predict forward.

## When to trigger
- Task has 2+ plausible approaches
- Past episodes contain relevant failures or surprises
- Unfamiliar territory (new API, new pattern, first time doing X)
- Consequences of failure are expensive (data loss, long recovery, broken state)

Do NOT trigger for: trivial tasks, clear instructions, pure research, or when
the user has already specified the exact approach.

## Process

### 1. Recall (30 seconds)
Scan memory for relevant signal. Check:
- `/workspace/memory/knowledge/index.yaml` — any related entities/topics?
- Today's episodes — did something similar already succeed or fail?
- CLAUDE.md heuristics — any learned lessons that apply?

You don't need to read every file. The index tells you where to look.
If nothing relevant exists, say so and move to step 2.

### 2. Simulate (2-3 approaches, 1-2 sentences each)
For each approach, ask:
- What's the **happy path**? (How does this succeed?)
- What's the **failure mode**? (How does this break?)
- What **past episode** informs this? (Or: "no prior experience")

Format (internal, not shown to user):
```
A: [approach] → happy: [outcome] | fail: [risk] | prior: [episode or "none"]
B: [approach] → happy: [outcome] | fail: [risk] | prior: [episode or "none"]
```

### 3. Choose (minimax)
Pick the approach with the **best worst-case**. Not the approach most likely
to succeed — the one where failure is least catastrophic.

If two approaches have similar worst-cases, pick the simpler one.

### 4. Identify the riskiest assumption
Every plan rests on assumptions. Name the ONE assumption most likely to be
wrong. Test it first — before building anything on top of it.

Examples:
- "This API endpoint exists" → curl it before writing the wrapper
- "This file format is parseable" → read a sample before building the pipeline
- "Port 465 works" → test before committing to that path

### 5. Execute with the escape hatch visible
Before starting, know how you'll detect failure early and what you'll
pivot to. Don't discover Plan B after Plan A is 80% done.

## What this is NOT
- Not EnterPlanMode (no user approval, no formal plan file)
- Not a delay tactic (total overhead: ~30 seconds of thinking)
- Not shown to the user unless they ask about your reasoning
- Not required for every task — only when the trigger conditions apply

## Connection to memory
The quality of simulation depends on the richness of episodes and knowledge.
A fresh instance with empty memory can only guess. An instance with 50 episodes
of past surprises can pattern-match against real experience.

This is why consolidation matters: it's not just bookkeeping.
It's building the substrate that makes imagination possible.
