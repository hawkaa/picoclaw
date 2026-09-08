import { CronExpressionParser } from "cron-parser";
import pino from "pino";

import { TASK_CHECK_INTERVAL } from "./config.ts";
import type { PreconditionOutcome } from "./precondition.ts";
import type {
	ContainerOutput,
	EffortLevel,
	ScheduledTask,
	SessionProfile,
} from "./types.ts";

const log = pino({ name: "task-scheduler" });

const MAX_CONCURRENT_TASKS = 3;

export interface SchedulerDeps {
	readTasks: () => ScheduledTask[];
	writeTasks: (tasks: ScheduledTask[]) => void;
	spawnEphemeral: (
		chatId: string,
		prompt: string,
		task: {
			id: string;
			label?: string | undefined;
			model?: string | undefined;
			effort?: EffortLevel | undefined;
			profile?: SessionProfile | undefined;
		},
	) => Promise<ContainerOutput>;
	sendMessage: (chatId: number | string, text: string) => Promise<void>;
	/**
	 * Decide whether a due task should actually spawn a container. Omitted →
	 * every due task spawns (pre-precondition behaviour).
	 */
	checkPrecondition?:
		| ((task: ScheduledTask) => Promise<PreconditionOutcome>)
		| undefined;
}

/**
 * Compute the next_run value for a task after it has executed.
 *
 * Exported for tests.
 */
export function computeNextRun(task: ScheduledTask): string | null {
	if (task.schedule_type === "cron") {
		try {
			const interval = CronExpressionParser.parse(task.schedule_value);
			return interval.next().toISOString();
		} catch {
			return null;
		}
	}
	if (task.schedule_type === "interval") {
		const ms = Number.parseInt(task.schedule_value, 10);
		return new Date(Date.now() + ms).toISOString();
	}
	return null; // "once" — no next run
}

/**
 * Merge scheduler-side changes back into the freshly-read tasks array.
 *
 * The scheduler holds a stale snapshot from before `spawnEphemeral` was
 * awaited.  During that await the IPC watcher may have written new tasks or
 * updated existing ones.  We must NOT overwrite those changes.
 *
 * Strategy:
 *   - Start from the fresh copy (canonical ground truth).
 *   - For every task that the scheduler touched (present in `updates`),
 *     apply only the field the scheduler is authorised to change: `status`.
 *   - `next_run` is re-derived from the FRESH `schedule_type` / `schedule_value`,
 *     so an IPC schedule change that landed during execution is honored.
 *     (Computing it inside `runTask` against the stale snapshot would clobber
 *     the IPC update.)
 *   - Tasks present in the fresh copy but absent from `updates` are
 *     left untouched (IPC additions are preserved).
 *   - Tasks present in `updates` but absent from the fresh copy are
 *     silently dropped (they were deleted via IPC while the task ran).
 */
export function mergeTasks(
	fresh: ScheduledTask[],
	updates: Map<string, { status: ScheduledTask["status"] }>,
): ScheduledTask[] {
	return fresh.map((task) => {
		const update = updates.get(task.id);
		if (!update) return task;
		const next_run = update.status === "paused" ? null : computeNextRun(task);
		return { ...task, next_run, status: update.status };
	});
}

/**
 * Split the due tasks into the ones that get a container and the ones whose
 * precondition said there is nothing to do.
 *
 * A skipped RECURRING task advances its schedule exactly as if it had run —
 * the schedule is a clock, not a backlog — which is why it still produces a
 * status update for `mergeTasks`.
 *
 * A skipped ONCE task produces no update at all: it stays armed with next_run
 * in the past, so it fires on the first tick where its condition holds ("run
 * when the wallet is funded", not "run at 03:00 or never"). The cost is that
 * its check runs every tick, so checks must stay cheap.
 */
export async function partitionByPrecondition(
	dueTasks: ScheduledTask[],
	checkPrecondition:
		| ((task: ScheduledTask) => Promise<PreconditionOutcome>)
		| undefined,
): Promise<{
	runnable: ScheduledTask[];
	skipUpdates: Map<string, { status: ScheduledTask["status"] }>;
}> {
	const runnable: ScheduledTask[] = [];
	const skipUpdates = new Map<string, { status: ScheduledTask["status"] }>();

	// Checks are short-lived host processes; run them concurrently.
	const outcomes = await Promise.all(
		dueTasks.map(async (task) => {
			if (!task.precondition || !checkPrecondition) return null;
			return await checkPrecondition(task);
		}),
	);

	dueTasks.forEach((task, i) => {
		const outcome = outcomes[i];
		if (!outcome || outcome.shouldSpawn) {
			runnable.push(task);
			return;
		}
		if (task.schedule_type !== "once") {
			skipUpdates.set(task.id, { status: "active" });
		}
	});

	return { runnable, skipUpdates };
}

/**
 * Simple semaphore to bound concurrent task execution.
 */
function makeSemaphore(limit: number) {
	let active = 0;
	const queue: Array<() => void> = [];

	function release() {
		active--;
		const next = queue.shift();
		if (next) next();
	}

	function acquire(): Promise<void> {
		if (active < limit) {
			active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			queue.push(() => {
				active++;
				resolve();
			});
		});
	}

	return { acquire, release };
}

export function startTaskScheduler(deps: SchedulerDeps): void {
	const check = async () => {
		const tasks = deps.readTasks();
		const now = new Date();

		const dueTasks = tasks.filter(
			(task) =>
				task.status === "active" &&
				task.next_run !== null &&
				new Date(task.next_run) <= now,
		);

		if (dueTasks.length === 0) {
			setTimeout(check, TASK_CHECK_INTERVAL);
			return;
		}

		// Collect the scheduler-side mutations as each task finishes.
		// Keyed by task.id → { status }. `next_run` is intentionally NOT
		// recorded here; it is re-derived in `mergeTasks` from the FRESH
		// task's schedule fields so IPC schedule updates that landed during
		// execution are honored.
		const updates = new Map<string, { status: ScheduledTask["status"] }>();

		const sem = makeSemaphore(MAX_CONCURRENT_TASKS);

		const runTask = async (task: ScheduledTask) => {
			await sem.acquire();
			log.info(
				{ taskId: task.id, prompt: task.prompt.slice(0, 80) },
				"Running scheduled task",
			);
			try {
				const result = await deps.spawnEphemeral(
					task.chatId,
					task.prompt,
					task,
				);
				if (result.result) {
					await deps.sendMessage(task.chatId, result.result);
				}
			} catch (err) {
				log.error({ taskId: task.id, err }, "Scheduled task failed");
			} finally {
				sem.release();
			}

			// Record only the status the scheduler wants to store. `next_run`
			// is computed later in `mergeTasks` against the fresh task.
			updates.set(task.id, {
				status: task.schedule_type === "once" ? "paused" : "active",
			});
		};

		// Precondition gate — the cheapest token in the system is the one a
		// container never boots to spend. Evaluated on the host, before any
		// spawn.
		const { runnable, skipUpdates } = await partitionByPrecondition(
			dueTasks,
			deps.checkPrecondition,
		);
		for (const [id, update] of skipUpdates) updates.set(id, update);

		if (runnable.length === 0 && updates.size === 0) {
			setTimeout(check, TASK_CHECK_INTERVAL);
			return;
		}

		// Spawn every runnable task concurrently (bounded by semaphore).
		await Promise.all(runnable.map((task) => runTask(task)));

		// Re-read tasks.json now that all spawns have finished.
		// This captures any IPC writes that occurred during execution.
		const freshTasks = deps.readTasks();
		const merged = mergeTasks(freshTasks, updates);
		deps.writeTasks(merged);

		setTimeout(check, TASK_CHECK_INTERVAL);
	};

	check();
	log.info("Task scheduler started");
}
