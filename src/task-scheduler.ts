import { CronExpressionParser } from "cron-parser";
import pino from "pino";

import { TASK_CHECK_INTERVAL } from "./config.ts";
import type { ContainerOutput, ScheduledTask } from "./types.ts";

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
			effort?: string | undefined;
		},
	) => Promise<ContainerOutput>;
	sendMessage: (chatId: number | string, text: string) => Promise<void>;
}

/**
 * Compute the next_run value for a task after it has executed.
 */
function computeNextRun(task: ScheduledTask): string | null {
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
 *     apply only the fields the scheduler is authorised to change:
 *     `next_run` and `status`.
 *   - Tasks present in the fresh copy but absent from `updates` are
 *     left untouched (IPC additions are preserved).
 *   - Tasks present in `updates` but absent from the fresh copy are
 *     silently dropped (they were deleted via IPC while the task ran).
 */
function mergeTasks(
	fresh: ScheduledTask[],
	updates: Map<string, Pick<ScheduledTask, "next_run" | "status">>,
): ScheduledTask[] {
	return fresh.map((task) => {
		const update = updates.get(task.id);
		if (!update) return task;
		return { ...task, next_run: update.next_run, status: update.status };
	});
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
		// Keyed by task.id → { next_run, status }.
		const updates = new Map<
			string,
			Pick<ScheduledTask, "next_run" | "status">
		>();

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

			// Determine what the scheduler wants to store for this task.
			if (task.schedule_type === "once") {
				updates.set(task.id, { next_run: null, status: "paused" });
			} else {
				updates.set(task.id, {
					next_run: computeNextRun(task),
					status: "active",
				});
			}
		};

		// Spawn all due tasks concurrently (bounded by semaphore).
		await Promise.all(dueTasks.map((task) => runTask(task)));

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
