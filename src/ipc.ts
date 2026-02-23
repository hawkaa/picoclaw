import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import pino from "pino";

import { DATA_DIR, IPC_POLL_INTERVAL, WORKSPACES_DIR } from "./config.ts";
import { sendMessage } from "./telegram.ts";
import type { ScheduledTask } from "./types.ts";

const log = pino({ name: "ipc" });

export interface IpcDeps {
	getAllowedChatId: () => string;
	readTasks: () => ScheduledTask[];
	writeTasks: (tasks: ScheduledTask[]) => void;
	writeSnapshot: (chatId: string, tasks: ScheduledTask[]) => void;
}

let running = false;

export function startIpcWatcher(deps: IpcDeps): void {
	if (running) return;
	running = true;

	let lastTasksMtime = 0;

	const poll = async () => {
		deps.getAllowedChatId();

		// Scan all chat IPC directories
		let chatIds: string[];
		try {
			if (!fs.existsSync(WORKSPACES_DIR)) {
				setTimeout(poll, IPC_POLL_INTERVAL);
				return;
			}
			chatIds = fs.readdirSync(WORKSPACES_DIR).filter((f) => {
				try {
					return fs.statSync(path.join(WORKSPACES_DIR, f)).isDirectory();
				} catch {
					return false;
				}
			});
		} catch {
			setTimeout(poll, IPC_POLL_INTERVAL);
			return;
		}

		for (const chatId of chatIds) {
			// Process outbound messages (agent → host → Telegram)
			const messagesDir = path.join(WORKSPACES_DIR, chatId, "ipc", "messages");
			if (fs.existsSync(messagesDir)) {
				const files = fs
					.readdirSync(messagesDir)
					.filter((f) => f.endsWith(".json"))
					.sort();
				for (const file of files) {
					const filePath = path.join(messagesDir, file);
					try {
						const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
						fs.unlinkSync(filePath);
						if (data.text) {
							await sendMessage(chatId, data.text);
							log.info({ chatId }, "IPC message sent to Telegram");
						}
					} catch (err) {
						log.error({ file, err }, "Error processing IPC message");
						try {
							fs.unlinkSync(filePath);
						} catch {}
					}
				}
			}

			// Process prayers (agent → runtime)
			const prayersDir = path.join(WORKSPACES_DIR, chatId, "ipc", "prayers");
			if (fs.existsSync(prayersDir)) {
				const files = fs
					.readdirSync(prayersDir)
					.filter((f) => f.endsWith(".json"))
					.sort();
				for (const file of files) {
					const filePath = path.join(prayersDir, file);
					try {
						const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
						fs.unlinkSync(filePath);
						fs.appendFileSync(
							path.join(DATA_DIR, "messages.jsonl"),
							`${JSON.stringify({ ts: new Date().toISOString(), chatId, ...data })}\n`,
						);
						log.info({ chatId }, "Prayer received");
					} catch (err) {
						log.error({ file, err }, "Error processing prayer");
						try {
							fs.unlinkSync(filePath);
						} catch {}
					}
				}
			}

			// Process task files (agent → host)
			const tasksDir = path.join(WORKSPACES_DIR, chatId, "ipc", "tasks");
			if (fs.existsSync(tasksDir)) {
				const files = fs
					.readdirSync(tasksDir)
					.filter((f) => f.endsWith(".json"))
					.sort();
				for (const file of files) {
					const filePath = path.join(tasksDir, file);
					try {
						const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
						fs.unlinkSync(filePath);
						processTaskIpc(data, chatId, deps);
					} catch (err) {
						log.error({ file, err }, "Error processing IPC task");
						try {
							fs.unlinkSync(filePath);
						} catch {}
					}
				}
			}
		}

		// Refresh snapshots for all chats whenever tasks.json changes on disk
		// (covers manual edits and scheduler next_run updates)
		try {
			const tasksFile = path.join(DATA_DIR, "tasks.json");
			const mtime = fs.existsSync(tasksFile)
				? fs.statSync(tasksFile).mtimeMs
				: 0;
			if (mtime !== lastTasksMtime) {
				lastTasksMtime = mtime;
				const allTasks = deps.readTasks();
				for (const chatId of chatIds) {
					deps.writeSnapshot(
						chatId,
						allTasks.filter((t) => t.chatId === chatId),
					);
				}
			}
		} catch (err) {
			log.warn({ err }, "Failed to refresh task snapshots");
		}

		setTimeout(poll, IPC_POLL_INTERVAL);
	};

	poll();
	log.info("IPC watcher started");
}

function computeNextRun(
	schedule_type: string,
	schedule_value: string,
): string | null {
	if (schedule_type === "cron") {
		try {
			return CronExpressionParser.parse(schedule_value).next().toISOString();
		} catch {
			return null;
		}
	}
	if (schedule_type === "interval") {
		const ms = Number.parseInt(schedule_value, 10);
		if (Number.isNaN(ms) || ms <= 0) return null;
		return new Date(Date.now() + ms).toISOString();
	}
	if (schedule_type === "once") {
		const d = new Date(schedule_value);
		if (Number.isNaN(d.getTime())) return null;
		return d.toISOString();
	}
	return null;
}

function processTaskIpc(
	data: {
		type: string;
		taskId?: string;
		label?: string;
		prompt?: string;
		schedule_type?: string;
		schedule_value?: string;
		status?: string;
		chatId?: string;
	},
	sourceChatId: string,
	deps: IpcDeps,
): void {
	const tasks = deps.readTasks();
	const chatId = data.chatId || sourceChatId;

	switch (data.type) {
		case "schedule": {
			if (!data.prompt || !data.schedule_type || !data.schedule_value) break;

			const nextRun = computeNextRun(data.schedule_type, data.schedule_value);
			if (nextRun === null && data.schedule_type !== "once") {
				log.warn({ data }, "Invalid schedule, ignoring");
				break;
			}

			// Upsert by label if provided
			if (data.label) {
				const existing = tasks.find(
					(t) => t.chatId === chatId && t.label === data.label,
				);
				if (existing) {
					existing.prompt = data.prompt;
					existing.schedule_type =
						data.schedule_type as ScheduledTask["schedule_type"];
					existing.schedule_value = data.schedule_value;
					existing.next_run = nextRun;
					existing.status = "active";
					deps.writeTasks(tasks);
					deps.writeSnapshot(
						chatId,
						tasks.filter((t) => t.chatId === chatId),
					);
					log.info(
						{ taskId: existing.id, label: data.label },
						"Task upserted via IPC",
					);
					break;
				}
			}

			const task: ScheduledTask = {
				id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				chatId,
				...(data.label ? { label: data.label } : {}),
				prompt: data.prompt,
				schedule_type: data.schedule_type as ScheduledTask["schedule_type"],
				schedule_value: data.schedule_value,
				next_run: nextRun,
				status: "active",
				created_at: new Date().toISOString(),
			};
			tasks.push(task);
			deps.writeTasks(tasks);
			deps.writeSnapshot(
				chatId,
				tasks.filter((t) => t.chatId === chatId),
			);
			log.info(
				{ taskId: task.id, label: task.label },
				"Task scheduled via IPC",
			);
			break;
		}
		case "update": {
			if (!data.taskId) break;
			const task = tasks.find((t) => t.id === data.taskId);
			if (!task) {
				log.warn({ taskId: data.taskId }, "Task not found for update");
				break;
			}
			if (data.prompt) task.prompt = data.prompt;
			if (data.status === "active" || data.status === "paused") {
				task.status = data.status;
			}
			if (data.schedule_type && data.schedule_value) {
				const nextRun = computeNextRun(data.schedule_type, data.schedule_value);
				if (nextRun !== null) {
					task.schedule_type =
						data.schedule_type as ScheduledTask["schedule_type"];
					task.schedule_value = data.schedule_value;
					task.next_run = nextRun;
				}
			}
			deps.writeTasks(tasks);
			deps.writeSnapshot(
				chatId,
				tasks.filter((t) => t.chatId === chatId),
			);
			log.info({ taskId: task.id }, "Task updated via IPC");
			break;
		}
		case "delete": {
			if (!data.taskId && !data.label) break;
			const before = tasks.length;
			const filtered = tasks.filter(
				(t) =>
					!(data.taskId ? t.id === data.taskId : false) &&
					!(data.label ? t.chatId === chatId && t.label === data.label : false),
			);
			deps.writeTasks(filtered);
			deps.writeSnapshot(
				chatId,
				filtered.filter((t) => t.chatId === chatId),
			);
			log.info(
				{
					taskId: data.taskId,
					label: data.label,
					removed: before - filtered.length,
				},
				"Task(s) deleted via IPC",
			);
			break;
		}
		default:
			log.warn({ type: data.type }, "Unknown IPC task type");
	}
}
