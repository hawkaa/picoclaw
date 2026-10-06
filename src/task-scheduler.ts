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

/**
 * One scheduler instance: a tick function plus the state that must survive
 * across ticks.
 *
 * A tick spawns every due task that is not already running and returns
 * without waiting for them. Each task writes its own status back (fresh read
 * + `mergeTasks`) when it finishes. Earlier, a tick awaited the whole batch
 * before the next tick could run, so a 60-90 min session held back every other
 * due cron and once-task until it exited.
 *
 * Concurrent writes: `readTasks`/`writeTasks` are synchronous and every writer
 * (this scheduler, the IPC watcher) does read-modify-write with no `await` in
 * between, so on the single JS thread each write is atomic with respect to the
 * others. `mergeTasks` keeps anything IPC wrote while the task ran.
 *
 * `startTaskScheduler` runs it in the production loop.
 */
function createTaskScheduler(deps: SchedulerDeps): {
	tick: () => Promise<Promise<void>[]>;
	inFlight: ReadonlySet<string>;
} {
	const inFlight = new Set<string>();
	// Shared across ticks, so the bound is on total running sessions.
	const sem = makeSemaphore(MAX_CONCURRENT_TASKS);

	const writeBack = (
		updates: Map<string, { status: ScheduledTask["status"] }>,
	) => {
		if (updates.size === 0) return;
		deps.writeTasks(mergeTasks(deps.readTasks(), updates));
	};

	const runTask = async (task: ScheduledTask) => {
		await sem.acquire();
		log.info(
			{ taskId: task.id, prompt: task.prompt.slice(0, 80) },
			"Running scheduled task",
		);
		try {
			const result = await deps.spawnEphemeral(task.chatId, task.prompt, task);
			if (result.result) {
				await deps.sendMessage(task.chatId, result.result);
			}
		} catch (err) {
			log.error({ taskId: task.id, err }, "Scheduled task failed");
		} finally {
			sem.release();
		}
		try {
			// `next_run` is re-derived in `mergeTasks` from the FRESH task, so
			// IPC schedule updates that landed during execution are honored.
			writeBack(
				new Map([
					[
						task.id,
						{ status: task.schedule_type === "once" ? "paused" : "active" },
					],
				]),
			);
		} catch (err) {
			log.error({ taskId: task.id, err }, "Failed to write task status");
		} finally {
			inFlight.delete(task.id);
		}
	};

	const tick = async (): Promise<Promise<void>[]> => {
		const now = new Date();
		const dueTasks = deps
			.readTasks()
			.filter(
				(task) =>
					task.status === "active" &&
					task.next_run !== null &&
					new Date(task.next_run) <= now &&
					!inFlight.has(task.id),
			);
		if (dueTasks.length === 0) return [];

		// Precondition gate — the cheapest token in the system is the one a
		// container never boots to spend. Evaluated on the host, before any
		// spawn.
		const { runnable, skipUpdates } = await partitionByPrecondition(
			dueTasks,
			deps.checkPrecondition,
		);
		writeBack(skipUpdates);

		// Claim synchronously, before anything else can tick.
		const fresh = runnable.filter((task) => !inFlight.has(task.id));
		for (const task of fresh) inFlight.add(task.id);
		return fresh.map((task) => runTask(task));
	};

	return { tick, inFlight };
}

export function startTaskScheduler(deps: SchedulerDeps): void {
	const { tick } = createTaskScheduler(deps);
	const loop = async () => {
		try {
			await tick();
		} catch (err) {
			log.error({ err }, "Scheduler tick failed");
		}
		setTimeout(loop, TASK_CHECK_INTERVAL);
	};
	loop();
	log.info("Task scheduler started");
}
