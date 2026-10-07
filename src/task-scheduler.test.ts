import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	checkTaskPrecondition,
	type PreconditionOutcome,
} from "./precondition.ts";
import {
	computeNextRun,
	mergeTasks,
	partitionByPrecondition,
	type SchedulerDeps,
	startTaskScheduler,
} from "./task-scheduler.ts";
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

	test("skipped recurring task advances next_run without having run", () => {
		// The whole point of the gate: no container was spawned, yet the cron
		// moves on to its next slot instead of firing again in 60 seconds.
		const task = makeTask({
			schedule_value: "0 * * * *",
			next_run: "2020-01-01T00:00:00.000Z",
			precondition: "imap-work --messages=INBOX",
		});
		const [merged] = mergeTasks(
			[task],
			new Map([[task.id, { status: "active" }]]),
		);
		expect(merged?.status).toBe("active");
		expect(new Date(merged?.next_run ?? "").getTime()).toBeGreaterThan(
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

describe("partitionByPrecondition", () => {
	const spawnOk: PreconditionOutcome = { shouldSpawn: true, reason: "passed" };
	const skip: PreconditionOutcome = { shouldSpawn: false, reason: "not-met" };

	test("no precondition → runs, and the check is never invoked", async () => {
		const task = makeTask();
		let calls = 0;
		const { runnable, skipUpdates } = await partitionByPrecondition(
			[task],
			async () => {
				calls++;
				return skip;
			},
		);
		expect(runnable).toEqual([task]);
		expect(skipUpdates.size).toBe(0);
		expect(calls).toBe(0);
	});

	test("precondition met → runs", async () => {
		const task = makeTask({ precondition: "imap-work --messages=INBOX" });
		const { runnable, skipUpdates } = await partitionByPrecondition(
			[task],
			async () => spawnOk,
		);
		expect(runnable).toEqual([task]);
		expect(skipUpdates.size).toBe(0);
	});

	test("precondition not met → no spawn, schedule still advances", async () => {
		const task = makeTask({ precondition: "imap-work --messages=INBOX" });
		const { runnable, skipUpdates } = await partitionByPrecondition(
			[task],
			async () => skip,
		);
		expect(runnable).toEqual([]);
		expect(skipUpdates.get(task.id)).toEqual({ status: "active" });
	});

	test("skipped 'once' task stays armed — no update, next_run untouched", async () => {
		// "Deploy when the wallet is funded": a one-shot task whose condition is
		// not yet true must NOT be consumed by the firing that skipped it.
		const task = makeTask({
			schedule_type: "once",
			next_run: "2020-01-01T00:00:00.000Z",
			precondition: "wallet-funded",
		});
		const { runnable, skipUpdates } = await partitionByPrecondition(
			[task],
			async () => skip,
		);
		expect(runnable).toEqual([]);
		expect(skipUpdates.size).toBe(0);
		// mergeTasks leaves a task it has no update for completely alone.
		const [merged] = mergeTasks([task], skipUpdates);
		expect(merged?.next_run).toBe("2020-01-01T00:00:00.000Z");
		expect(merged?.status).toBe("active");
	});

	test("mixed batch: only the gated task is held back", async () => {
		const open = makeTask({ id: "open" });
		const gated = makeTask({ id: "gated", precondition: "no-work" });
		const alsoOpen = makeTask({ id: "also-open", precondition: "has-work" });
		const { runnable, skipUpdates } = await partitionByPrecondition(
			[open, gated, alsoOpen],
			async (t) => (t.id === "gated" ? skip : spawnOk),
		);
		expect(runnable.map((t) => t.id)).toEqual(["open", "also-open"]);
		expect([...skipUpdates.keys()]).toEqual(["gated"]);
	});

	test("no checker wired → preconditions are inert, everything runs", async () => {
		// Backwards compatibility: a host that never wires checkPrecondition
		// behaves exactly as it did before this feature existed.
		const task = makeTask({ precondition: "imap-work" });
		const { runnable, skipUpdates } = await partitionByPrecondition(
			[task],
			undefined,
		);
		expect(runnable).toEqual([task]);
		expect(skipUpdates.size).toBe(0);
	});

	test("end to end: real checker, real shipped check, no spawn", async () => {
		// Every case above hands partitionByPrecondition a fake outcome, which
		// tests the partition and not the wiring. This one runs the function
		// index.ts actually passes, against a file that actually ships.
		const hb = path.join(
			os.tmpdir(),
			`picoclaw-scheduler-hb-${process.pid}-${Date.now()}`,
		);
		fs.writeFileSync(hb, "");
		try {
			const task = makeTask({ precondition: `heartbeat-stale ${hb} 3600` });
			const { runnable, skipUpdates } = await partitionByPrecondition(
				[task],
				(t) => checkTaskPrecondition(t),
			);
			expect(runnable).toEqual([]);
			expect(skipUpdates.get(task.id)).toEqual({ status: "active" });
		} finally {
			fs.rmSync(hb, { force: true });
		}
	});
});

describe("startTaskScheduler — a running session does not block the queue", () => {
	// Drives the real production loop. setTimeout is captured so each tick is
	// fired by hand instead of every 60s.
	async function harness(initial: ScheduledTask[]) {
		let store = initial.map((t) => ({ ...t }));
		const spawned: string[] = [];
		const finish = new Map<string, () => void>();
		const ticks: Array<() => void> = [];
		const deps: SchedulerDeps = {
			readTasks: () => store.map((t) => ({ ...t })),
			writeTasks: (tasks) => {
				store = tasks.map((t) => ({ ...t }));
			},
			spawnEphemeral: (_chat, _prompt, task) => {
				spawned.push(task.id);
				return new Promise((resolve) => {
					finish.set(task.id, () =>
						resolve({ status: "success", result: null }),
					);
				});
			},
			sendMessage: async () => {},
		};
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void) => {
			ticks.push(fn);
			return 0;
		}) as unknown as typeof setTimeout;
		const settle = () => new Promise((r) => realSetTimeout(r, 5));
		const restore = () => {
			globalThis.setTimeout = realSetTimeout;
		};
		startTaskScheduler(deps);
		await settle();
		return {
			spawned,
			finish,
			settle,
			restore,
			store: () => store,
			addTask: (t: ScheduledTask) => {
				store = [...store, t];
			},
			nextTick: async () => {
				const fn = ticks.shift();
				if (fn) fn();
				await settle();
				return fn !== undefined;
			},
		};
	}

	const past = "2020-01-01T00:00:00.000Z";

	test("a once-task created while a long session runs spawns on the next tick", async () => {
		const h = await harness([
			makeTask({
				id: "long",
				schedule_type: "cron",
				schedule_value: "0 3 * * *",
				next_run: past,
			}),
		]);
		try {
			expect(h.spawned).toEqual(["long"]);
			// Mid-session: IPC writes a "run once now" task.
			h.addTask(
				makeTask({
					id: "probe",
					schedule_type: "once",
					schedule_value: past,
					next_run: past,
				}),
			);
			// The next check must be scheduled while "long" is still running…
			expect(await h.nextTick()).toBe(true);
			// …and it must spawn the probe without waiting for "long".
			expect(h.spawned).toEqual(["long", "probe"]);
		} finally {
			h.restore();
		}
	});

	test("a running task is not spawned twice while its next_run is still past", async () => {
		const h = await harness([
			makeTask({
				id: "long",
				schedule_type: "cron",
				schedule_value: "0 3 * * *",
				next_run: past,
			}),
		]);
		try {
			await h.nextTick();
			await h.nextTick();
			expect(h.spawned).toEqual(["long"]);
		} finally {
			h.restore();
		}
	});

	test("each task writes its own status when it finishes, keeping IPC writes", async () => {
		const h = await harness([
			makeTask({
				id: "long",
				schedule_type: "cron",
				schedule_value: "0 3 * * *",
				next_run: past,
			}),
		]);
		try {
			h.addTask(
				makeTask({
					id: "probe",
					schedule_type: "once",
					schedule_value: past,
					next_run: past,
				}),
			);
			await h.nextTick();
			h.finish.get("probe")?.();
			await h.settle();
			const afterProbe = h.store();
			expect(afterProbe.find((t) => t.id === "probe")?.status).toBe("paused");
			// "long" is still running: untouched, still due.
			expect(afterProbe.find((t) => t.id === "long")?.next_run).toBe(past);

			// IPC adds a task while "long" runs; its write-back must keep it.
			h.addTask(
				makeTask({ id: "ipc-added", next_run: "2099-01-01T00:00:00.000Z" }),
			);
			h.finish.get("long")?.();
			await h.settle();
			const end = h.store();
			expect(end.map((t) => t.id).sort()).toEqual([
				"ipc-added",
				"long",
				"probe",
			]);
			const long = end.find((t) => t.id === "long");
			expect(long?.status).toBe("active");
			expect(new Date(long?.next_run ?? 0).getTime()).toBeGreaterThan(
				Date.now(),
			);

			// Finished, so it may be picked up again when next due.
			expect(h.spawned).toEqual(["long", "probe"]);
		} finally {
			h.restore();
		}
	});
});
