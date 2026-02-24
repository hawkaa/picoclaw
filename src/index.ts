import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import { DATA_DIR, IDLE_TIMEOUT, WORKSPACES_DIR } from "./config.ts";
import {
	cleanupOrphanedContainers,
	clearSessionFiles,
	ensureIpcDirs,
	ensureSessionsDir,
	seedWorkspace,
	spawnContainer,
	writeCloseSentinel,
	writeIpcInput,
	writeTasksSnapshot,
} from "./container-runner.ts";
import { startIpcWatcher } from "./ipc.ts";
import { startTaskScheduler } from "./task-scheduler.ts";
import {
	getUpdates,
	sendChatAction,
	sendMessage,
	setMyCommands,
	type TelegramUpdate,
} from "./telegram.ts";
import type {
	ContainerOutput,
	ContainerState,
	ScheduledTask,
	SessionData,
} from "./types.ts";
import { commitWorkspace, ensureWorkspaceGit } from "./workspace-git.ts";

const log = pino({
	name: "picoclaw",
	transport: { target: "pino-pretty" },
});

const ALLOWED_USER_ID = process.env["TELEGRAM_ALLOWED_USER_ID"] ?? "";
if (!ALLOWED_USER_ID) {
	log.fatal("TELEGRAM_ALLOWED_USER_ID not set");
	process.exit(1);
}
if (!process.env["TELEGRAM_BOT_TOKEN"]) {
	log.fatal("TELEGRAM_BOT_TOKEN not set");
	process.exit(1);
}

// --- State ---
const containers = new Map<string, ContainerState>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

const TYPING_INTERVAL = 4000;

// --- Persistence helpers ---
function sessionsFile(): string {
	return path.join(DATA_DIR, "sessions.json");
}
function tasksFile(): string {
	return path.join(DATA_DIR, "tasks.json");
}

function readSessions(): Record<string, SessionData> {
	try {
		if (fs.existsSync(sessionsFile()))
			return JSON.parse(fs.readFileSync(sessionsFile(), "utf-8"));
	} catch {}
	return {};
}

function writeSessions(data: Record<string, SessionData>): void {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(sessionsFile(), JSON.stringify(data, null, 2));
}

function readTasks(): ScheduledTask[] {
	try {
		if (fs.existsSync(tasksFile()))
			return JSON.parse(fs.readFileSync(tasksFile(), "utf-8"));
	} catch {}
	return [];
}

function writeTasks(tasks: ScheduledTask[]): void {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(tasksFile(), JSON.stringify(tasks, null, 2));
}

// --- Session lifecycle ---
function startTyping(chatId: string): void {
	stopTyping(chatId);
	typingIntervals.set(
		chatId,
		setInterval(() => {
			if (containers.has(chatId)) {
				sendChatAction(chatId).catch(() => {});
			} else {
				stopTyping(chatId);
			}
		}, TYPING_INTERVAL),
	);
}

function stopTyping(chatId: string): void {
	const interval = typingIntervals.get(chatId);
	if (interval) {
		clearInterval(interval);
		typingIntervals.delete(chatId);
	}
}

function resetIdleTimer(chatId: string): void {
	const existing = idleTimers.get(chatId);
	if (existing) clearTimeout(existing);

	idleTimers.set(
		chatId,
		setTimeout(() => {
			const state = containers.get(chatId);
			if (state) {
				log.info({ chatId }, "Idle timeout, closing container");
				writeCloseSentinel(chatId);
				containers.delete(chatId);
				stopTyping(chatId);
				idleTimers.delete(chatId);
			}
		}, IDLE_TIMEOUT),
	);
}

async function handleOutput(
	chatId: string,
	output: ContainerOutput,
): Promise<void> {
	// Update session ID
	if (output.newSessionId) {
		const sessions = readSessions();
		sessions[chatId] = {
			sessionId: output.newSessionId,
			lastActivity: new Date().toISOString(),
		};
		writeSessions(sessions);

		const state = containers.get(chatId);
		if (state) state.sessionId = output.newSessionId;
	}

	// Send result to Telegram
	if (output.result) {
		log.info(
			{
				chatId,
				resultLength: output.result.length,
				preview: output.result.slice(0, 200),
			},
			"Forwarding result to Telegram",
		);
		await sendMessage(chatId, output.result);
	} else {
		log.debug({ chatId }, "Output with null result (session update only)");
	}

	// Agent finished its turn — stop typing until user sends another message
	stopTyping(chatId);

	// Reset idle timer on any output
	resetIdleTimer(chatId);
}

async function startContainer(
	chatId: string,
	prompt: string,
	caller?: { name: string; source: "telegram" | "scheduler" } | undefined,
): Promise<void> {
	// Prepare workspace
	seedWorkspace(chatId);
	ensureWorkspaceGit(chatId);
	ensureSessionsDir(chatId);
	ensureIpcDirs(chatId);

	// Write tasks snapshot for the container
	const tasks = readTasks().filter((t) => t.chatId === chatId);
	writeTasksSnapshot(
		chatId,
		tasks as unknown as Array<Record<string, unknown>>,
	);

	const sessions = readSessions();
	const sessionId = sessions[chatId]?.sessionId;

	await sendChatAction(chatId);

	const { proc, containerName, result } = await spawnContainer(
		chatId,
		{ prompt, sessionId, chatId, caller },
		(output) => handleOutput(chatId, output),
	);

	containers.set(chatId, {
		proc,
		containerName,
		chatId,
		sessionId,
		lastActivity: Date.now(),
	});

	startTyping(chatId);
	resetIdleTimer(chatId);

	// When container exits, clean up
	result
		.then((finalOutput) => {
			containers.delete(chatId);
			stopTyping(chatId);
			const timer = idleTimers.get(chatId);
			if (timer) {
				clearTimeout(timer);
				idleTimers.delete(chatId);
			}

			if (finalOutput.newSessionId) {
				const sessions = readSessions();
				sessions[chatId] = {
					sessionId: finalOutput.newSessionId,
					lastActivity: new Date().toISOString(),
				};
				writeSessions(sessions);
			}

			if (finalOutput.status === "error") {
				log.error({ chatId, error: finalOutput.error }, "Container error");
			}

			commitWorkspace(chatId, { containerName, caller, prompt }).catch(
				() => {},
			);
		})
		.catch((err) => {
			log.error({ chatId, err }, "Container result promise rejected");
			containers.delete(chatId);
			stopTyping(chatId);
		});
}

async function handleMessage(update: TelegramUpdate): Promise<void> {
	const msg = update.message;
	if (!msg?.text || !msg.from) return;

	const userId = String(msg.from.id);
	const chatId = String(msg.chat.id);

	// User allowlist
	if (userId !== ALLOWED_USER_ID) {
		log.debug({ userId }, "Ignoring message from non-allowed user");
		return;
	}

	const text = msg.text.trim();

	// /new command: reset session
	if (text === "/new") {
		const state = containers.get(chatId);
		if (state) {
			writeCloseSentinel(chatId);
			containers.delete(chatId);
			stopTyping(chatId);
			const timer = idleTimers.get(chatId);
			if (timer) {
				clearTimeout(timer);
				idleTimers.delete(chatId);
			}
		}
		// Clear session ID and wipe Claude session files
		const sessions = readSessions();
		delete sessions[chatId];
		writeSessions(sessions);
		clearSessionFiles(chatId);
		await sendMessage(chatId, "Session reset.");
		return;
	}

	const callerName = msg.from.username ?? msg.from.first_name ?? "unknown";
	const caller = { name: callerName, source: "telegram" as const };

	// Active container → pipe follow-up
	const state = containers.get(chatId);
	if (state) {
		state.lastActivity = Date.now();
		writeIpcInput(chatId, text, caller);
		startTyping(chatId);
		await sendChatAction(chatId);
		return;
	}

	// No container → spawn new one
	await startContainer(chatId, text, caller);
}

// --- Ephemeral container for scheduled tasks ---
async function spawnEphemeral(
	chatId: string,
	prompt: string,
	task: { id: string; label?: string | undefined },
): Promise<ContainerOutput> {
	seedWorkspace(chatId);
	ensureWorkspaceGit(chatId);
	ensureSessionsDir(chatId);
	ensureIpcDirs(chatId);

	const tasks = readTasks().filter((t) => t.chatId === chatId);
	writeTasksSnapshot(
		chatId,
		tasks as unknown as Array<Record<string, unknown>>,
	);

	const caller = {
		name: task.label ?? task.id,
		source: "scheduler" as const,
	};

	const { result } = await spawnContainer(chatId, {
		prompt,
		chatId,
		isScheduledTask: true,
		caller,
	});
	const output = await result;
	await commitWorkspace(chatId, {
		caller,
		prompt,
	}).catch(() => {});
	return output;
}

// --- Main loop ---
async function main(): Promise<void> {
	log.info("PicoClaw starting...");

	await cleanupOrphanedContainers();

	await setMyCommands([{ command: "new", description: "Start a new session" }]);

	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

	// Start subsystems
	startIpcWatcher({
		getAllowedChatId: () => ALLOWED_USER_ID,
		readTasks,
		writeTasks,
		writeSnapshot: (chatId, tasks) =>
			writeTasksSnapshot(
				chatId,
				tasks as unknown as Array<Record<string, unknown>>,
			),
	});

	startTaskScheduler({
		readTasks,
		writeTasks,
		spawnEphemeral,
	});

	// Telegram polling loop
	let offset: number | undefined;
	log.info("Starting Telegram polling...");

	while (true) {
		try {
			const updates = await getUpdates(offset);
			for (const update of updates) {
				offset = update.update_id + 1;
				try {
					await handleMessage(update);
				} catch (err) {
					log.error(
						{ err, update_id: update.update_id },
						"Error handling message",
					);
				}
			}
		} catch (err) {
			log.error({ err }, "Telegram polling error, retrying in 5s");
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

// Graceful shutdown
function shutdown(): void {
	log.info("Shutting down...");
	for (const [chatId, _state] of containers) {
		log.info({ chatId }, "Closing container");
		writeCloseSentinel(chatId);
	}
	// Give containers a moment to exit
	setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
	log.fatal({ err }, "Fatal error");
	process.exit(1);
});
