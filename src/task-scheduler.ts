import { CronExpressionParser } from "cron-parser";
import pino from "pino";

import { TASK_CHECK_INTERVAL } from "./config.ts";
import type { ContainerOutput, ScheduledTask } from "./types.ts";

const log = pino({ name: "task-scheduler" });

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
		},
	) => Promise<ContainerOutput>;
	sendMessage: (chatId: number | string, text: string) => Promise<void>;
}

export function startTaskScheduler(deps: SchedulerDeps): void {
	const check = async () => {
		const tasks = deps.readTasks();
		const now = new Date();
		let modified = false;

		for (const task of tasks) {
			if (task.status !== "active" || !task.next_run) continue;
			if (new Date(task.next_run) > now) continue;

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
			}

			// Update next_run or remove if one-shot
			if (task.schedule_type === "once") {
				task.next_run = null;
				task.status = "paused"; // Done
			} else if (task.schedule_type === "cron") {
				try {
					const interval = CronExpressionParser.parse(task.schedule_value);
					task.next_run = interval.next().toISOString();
				} catch {
					task.next_run = null;
				}
			} else if (task.schedule_type === "interval") {
				const ms = Number.parseInt(task.schedule_value, 10);
				task.next_run = new Date(Date.now() + ms).toISOString();
			}
			modified = true;
		}

		if (modified) deps.writeTasks(tasks);
		setTimeout(check, TASK_CHECK_INTERVAL);
	};

	check();
	log.info("Task scheduler started");
}
