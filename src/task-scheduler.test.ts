import { describe, expect, test } from "bun:test";

import { computeNextRun, mergeTasks } from "./task-scheduler.ts";
import type { ScheduledTask } from "./types.ts";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		id: "task-1",
		chatId: "chat-1",
		prompt: "do thing",
		schedule_type: "cron",
		schedule_value: "0 * * * *",
		next_run: "2030-01-01T00:00:00.000Z",
		status: "active",
		created_at: "2030-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("computeNextRun", () => {
	test("cron — next firing parsed from schedule_value", () => {
		const result = computeNextRun(
			makeTask({ schedule_type: "cron", schedule_value: "0 5-22 * * *" }),
		);
		// Hours 5-22 only, so the next firing is always in that window.
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.\d{3}Z$/);
		if (result) {
			const hour = new Date(result).getUTCHours();
			expect(hour).toBeGreaterThanOrEqual(5);
			expect(hour).toBeLessThanOrEqual(22);
		}
	});

	test("cron — invalid expression returns null", () => {
		const result = computeNextRun(
			makeTask({ schedule_type: "cron", schedule_value: "this is not cron" }),
		);
		expect(result).toBeNull();
	});

	test("interval — next_run = now + ms", () => {
		const before = Date.now();
		const result = computeNextRun(
			makeTask({ schedule_type: "interval", schedule_value: "60000" }),
		);
		expect(result).not.toBeNull();
		const t = new Date(result ?? "").getTime();
		expect(t - before).toBeGreaterThanOrEqual(60000 - 100);
		expect(t - before).toBeLessThanOrEqual(60000 + 1000);
	});

	test("once — returns null", () => {
		const result = computeNextRun(
			makeTask({
				schedule_type: "once",
				schedule_value: "2030-01-01T00:00:00Z",
			}),
		);
		expect(result).toBeNull();
	});
});

describe("mergeTasks", () => {
	test("regression: IPC schedule change during execution is honored", () => {
		// Scenario:
		//   1. Scheduler reads tasks at T0 with cron "0 * * * *" (every hour).
		//   2. Task spawns and runs.
		//   3. During the run, IPC updates schedule_value to "0 5-22 * * *"
		//      (skips hours 23-04 UTC) and recomputes next_run accordingly.
		//   4. Task finishes; scheduler writes its updates back.
		// Before the fix, the scheduler's stored `next_run` was computed from
		// the stale "0 * * * *" snapshot — clobbering the IPC update and
		// causing the task to fire in a now-disabled hour. After the fix,
		// `next_run` is recomputed against the FRESH "0 5-22 * * *".
		const freshTask = makeTask({
			schedule_value: "0 5-22 * * *",
			next_run: "2030-01-01T05:00:00.000Z", // IPC-recomputed
		});
		const updates = new Map<string, { status: ScheduledTask["status"] }>([
			[freshTask.id, { status: "active" }],
		]);

		const [merged] = mergeTasks([freshTask], updates);
		expect(merged).toBeDefined();
		if (!merged) return;

		// Status is the scheduler's authority.
		expect(merged.status).toBe("active");
		// Fresh schedule_value must be preserved.
		expect(merged.schedule_value).toBe("0 5-22 * * *");
		// next_run must come from the fresh cron, NOT a stale "0 * * * *"
		// snapshot — meaning the next firing must land in hours 5-22.
		expect(merged.next_run).not.toBeNull();
		const nextHour = new Date(merged.next_run ?? "").getUTCHours();
		expect(nextHour).toBeGreaterThanOrEqual(5);
		expect(nextHour).toBeLessThanOrEqual(22);
	});

	test("once task — status paused, next_run null", () => {
		const freshTask = makeTask({
			schedule_type: "once",
			schedule_value: "2030-01-01T00:00:00Z",
		});
		const updates = new Map<string, { status: ScheduledTask["status"] }>([
			[freshTask.id, { status: "paused" }],
		]);

		const [merged] = mergeTasks([freshTask], updates);
		expect(merged).toBeDefined();
		if (!merged) return;
		expect(merged.status).toBe("paused");
		expect(merged.next_run).toBeNull();
	});

	test("interval task — IPC schedule change honored", () => {
		// Fresh interval is 30s; original (stale) was 60s. Without the fix,
		// the scheduler would write next_run = now + 60s instead of + 30s.
		const freshTask = makeTask({
			schedule_type: "interval",
			schedule_value: "30000",
		});
		const updates = new Map<string, { status: ScheduledTask["status"] }>([
			[freshTask.id, { status: "active" }],
		]);

		const before = Date.now();
		const [merged] = mergeTasks([freshTask], updates);
		expect(merged).toBeDefined();
		if (!merged) return;
		expect(merged.next_run).not.toBeNull();
		const delta = new Date(merged.next_run ?? "").getTime() - before;
		// Must reflect FRESH 30s interval, not stale 60s.
		expect(delta).toBeGreaterThanOrEqual(30000 - 100);
		expect(delta).toBeLessThanOrEqual(30000 + 1000);
	});

	test("task absent from updates is preserved unchanged", () => {
		const t1 = makeTask({ id: "t1", next_run: "2030-01-01T01:00:00.000Z" });
		const t2 = makeTask({ id: "t2", next_run: "2030-01-01T02:00:00.000Z" });
		const updates = new Map<string, { status: ScheduledTask["status"] }>([
			[t1.id, { status: "active" }],
		]);
		const merged = mergeTasks([t1, t2], updates);
		const mergedT2 = merged.find((t) => t.id === "t2");
		expect(mergedT2).toBeDefined();
		expect(mergedT2?.next_run).toBe("2030-01-01T02:00:00.000Z");
		expect(mergedT2?.status).toBe("active");
	});

	test("regression: stale next_run on the fresh task is overwritten by recomputation", () => {
		// Simulates the exact failure mode observed in production:
		// tasks.json on disk had cron `0 5-22 * * *` (IPC-updated) but next_run
		// stuck at 01:00Z because a previous run wrote next_run computed from
		// the prior `0 * * * *` cron. After the fix, mergeTasks ignores any
		// stale next_run on the fresh task and re-derives from the cron.
		const staleNextRun = "2020-01-01T01:00:00.000Z"; // way in the past
		const freshTask = makeTask({
			schedule_value: "0 5-22 * * *",
			next_run: staleNextRun,
		});
		const updates = new Map<string, { status: ScheduledTask["status"] }>([
			[freshTask.id, { status: "active" }],
		]);
		const [merged] = mergeTasks([freshTask], updates);
		expect(merged).toBeDefined();
		if (!merged) return;
		// Must NOT keep the stale next_run.
		expect(merged.next_run).not.toBe(staleNextRun);
		// Must be in the future.
		expect(new Date(merged.next_run ?? "").getTime()).toBeGreaterThan(
			Date.now(),
		);
	});

	test("task in updates but absent from fresh is dropped (IPC deletion)", () => {
		const t1 = makeTask({ id: "t1" });
		// updates references a task that no longer exists in `fresh`.
		const updates = new Map<string, { status: ScheduledTask["status"] }>([
			[t1.id, { status: "active" }],
			["t-deleted", { status: "active" }],
		]);
		const merged = mergeTasks([t1], updates);
		expect(merged.length).toBe(1);
		expect(merged[0]?.id).toBe("t1");
	});
});
