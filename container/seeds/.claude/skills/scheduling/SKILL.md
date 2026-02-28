---
name: scheduling
description: |
  How to create, update, pause, and delete scheduled tasks by writing JSON
  files to /ipc/tasks/. Supports cron expressions, one-time timestamps, and
  interval-based scheduling. Use labels for idempotent recurring tasks.
author: picoclaw
version: 2.0.0
---

# Task Scheduling

Schedule tasks by writing JSON files to `/ipc/tasks/` with a unique filename
(e.g. `$(date +%s%N).json`). The host picks them up within seconds, deletes
the file, and persists the task.

Read `/ipc/current_tasks.yaml` to see all current tasks with their IDs and
labels. This file is written fresh each time a container starts.

---

## Create or update a recurring task (upsert by label)

Use a `label` to make scheduling idempotent. If a task with that label already
exists for this chat, it is updated in place rather than duplicated.

```json
{
  "type": "schedule",
  "label": "daily-digest",
  "prompt": "Fetch the top 5 Hacker News stories and send a summary.",
  "schedule_type": "cron",
  "schedule_value": "0 0 * * *"
}
```

### Model override

Add an optional `"model"` field to run a task with a specific model. Accepts
aliases (`opus`, `sonnet`, `haiku`) or full model IDs (e.g. `claude-opus-4-6`).
If omitted, the task uses the system default at the time it runs.

```json
{
  "type": "schedule",
  "label": "deep-analysis",
  "prompt": "Analyze yesterday's metrics in detail.",
  "schedule_type": "cron",
  "schedule_value": "0 7 * * *",
  "model": "opus"
}
```

Always use a label for recurring tasks so re-runs of your setup logic are safe.

### Schedule types

| type | schedule_value | example |
|------|---------------|---------|
| `cron` | Standard cron expression | `"0 9 * * 1-5"` (weekdays 9am) |
| `once` | ISO 8601 timestamp | `"2025-06-01T08:00:00Z"` |
| `interval` | Milliseconds between runs | `"3600000"` (hourly) |

---

## Update an existing task

Change the prompt, schedule, or status of a task by its ID.

```json
{"type": "update", "taskId": "task-abc123", "schedule_value": "0 8 * * *"}
```

```json
{"type": "update", "taskId": "task-abc123", "prompt": "Updated prompt text."}
```

```json
{"type": "update", "taskId": "task-abc123", "status": "paused"}
```

```json
{"type": "update", "taskId": "task-abc123", "status": "active"}
```

Set or change the model:

```json
{"type": "update", "taskId": "task-abc123", "model": "haiku"}
```

Clear the model override (revert to system default):

```json
{"type": "update", "taskId": "task-abc123", "model": ""}
```

You can combine fields in one call:

```json
{"type": "update", "taskId": "task-abc123", "prompt": "New prompt.", "schedule_value": "0 6 * * *"}
```

---

## Delete a task

By task ID:

```json
{"type": "delete", "taskId": "task-abc123"}
```

By label (deletes all tasks with that label for this chat):

```json
{"type": "delete", "label": "daily-digest"}
```

---

## Typical workflows

**Set up a recurring task (safe to run multiple times):**
1. Read `/ipc/current_tasks.yaml` to check current state
2. Write a `schedule` with a label — host upserts if it already exists

**Tune an existing task:**
1. Read `/ipc/current_tasks.yaml` to get the task ID
2. Write an `update` with the fields to change

**Remove a task:**
- If you know the label: `delete` by label
- If you only have the ID: `delete` by taskId

---

## Notes

- Each scheduled run executes in its own ephemeral container — no session state
- Your last text output is sent as a Telegram message automatically
- If you need a follow-up from the user, persist the relevant context to /workspace/ so the next session can pick it up
- `current_tasks.yaml` reflects state at container start; re-read is not possible mid-session
- Filename for IPC files must be unique — use a timestamp or random suffix
