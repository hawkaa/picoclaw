import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import {
	DATA_DIR,
	IDLE_TIMEOUT,
	loadBotConfigs,
	MODEL_ALIASES,
	resolveModelId,
	WORKSPACES_DIR,
} from "./config.ts";
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
import { TelegramClient, type TelegramUpdate } from "./telegram.ts";
import type {
	BotConfig,
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

// --- Load bot configs ---
const botConfigs = loadBotConfigs();
if (botConfigs.length === 0) {
	log.fatal("No bots configured in bots.json");
	process.exit(1);
}

// Build allowed userId → BotConfig lookup and TelegramClient instances
const clientsByUserId = new Map<string, TelegramClient>();
const clientsByChatId = new Map<string, TelegramClient>();
const configsByUserId = new Map<string, BotConfig>();
const clients: TelegramClient[] = [];

for (const cfg of botConfigs) {
	const client = new TelegramClient(cfg.name, cfg.botToken, cfg.allowedUserId);
	clientsByUserId.set(cfg.allowedUserId, client);
	configsByUserId.set(cfg.allowedUserId, cfg);
	clients.push(client);
}

/** Look up the BotConfig for a given chatId (via the client routing table). */
function botConfigForChat(chatId: string): BotConfig | undefined {
	const client = clientsByChatId.get(chatId);
	if (!client) return undefined;
	return configsByUserId.get(client.allowedUserId);
}

/** Dispatcher: route sendMessage to the correct bot by chatId */
async function dispatchMessage(
	chatId: number | string,
	text: string,
): Promise<void> {
	const client = clientsByChatId.get(String(chatId));
	if (client) {
		await client.sendMessage(chatId, text);
		return;
	}
	// Fallback: try all clients (first message from a chat before routing is set up)
	for (const c of clients) {
		try {
			await c.sendMessage(chatId, text);
			clientsByChatId.set(String(chatId), c);
			return;
		} catch {
			// Try next client
		}
	}
	log.warn({ chatId }, "No bot client could send message to this chatId");
}

/** Dispatcher for sendChatAction */
async function dispatchChatAction(
	chatId: number | string,
	action = "typing",
): Promise<void> {
	const client = clientsByChatId.get(String(chatId));
	if (client) {
		await client.sendChatAction(chatId, action);
		return;
	}
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
				dispatchChatAction(chatId).catch(() => {});
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
				writeCloseSentinel(chatId, state.containerName);
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
		const existing = sessions[chatId];
		sessions[chatId] = {
			sessionId: output.newSessionId,
			lastActivity: new Date().toISOString(),
			model: existing?.model,
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
		await dispatchMessage(chatId, output.result);
	} else {
		log.debug({ chatId }, "Output with null result (session update only)");
	}

	// Only stop typing on final result, not streaming text blocks
	if (output.type !== "text") {
		stopTyping(chatId);
	}

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
	const session = sessions[chatId];
	const sessionId = session?.sessionId || undefined;
	const model = session?.model ?? botConfigForChat(chatId)?.defaultModel;

	await dispatchChatAction(chatId);

	const { proc, containerName, result } = await spawnContainer(
		chatId,
		{ prompt, sessionId, chatId, caller, model },
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
				const existing = sessions[chatId];
				sessions[chatId] = {
					sessionId: finalOutput.newSessionId,
					lastActivity: new Date().toISOString(),
					model: existing?.model,
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

async function handleMessage(
	update: TelegramUpdate,
	client: TelegramClient,
	allowedUserId: string,
): Promise<void> {
	const msg = update.message;
	if (!msg?.text || !msg.from) return;

	const userId = String(msg.from.id);
	const chatId = String(msg.chat.id);

	// User allowlist
	if (userId !== allowedUserId) {
		log.warn(
			{ userId, bot: client.name },
			"Ignoring message from non-allowed user",
		);
		return;
	}

	// Register chatId → client routing
	clientsByChatId.set(chatId, client);

	const text = msg.text.trim();

	// /new command: reset session (optionally with model)
	if (text === "/new" || text.startsWith("/new ")) {
		const modelArg = text.slice("/new".length).trim();

		// Validate model argument if provided
		let model: string | undefined;
		if (modelArg) {
			// Check if it's a known alias or looks like a model ID (contains hyphen)
			const resolved = resolveModelId(modelArg);
			if (resolved === modelArg && !modelArg.includes("-")) {
				const aliases = Object.keys(MODEL_ALIASES).join(", ");
				await client.sendMessage(
					chatId,
					`Unknown model "${modelArg}". Valid aliases: ${aliases}`,
				);
				return;
			}
			model = resolved;
		}

		const state = containers.get(chatId);
		if (state) {
			writeCloseSentinel(chatId, state.containerName);
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
		if (model) {
			sessions[chatId] = {
				sessionId: "",
				lastActivity: new Date().toISOString(),
				model,
			};
		} else {
			delete sessions[chatId];
		}
		writeSessions(sessions);
		clearSessionFiles(chatId);

		const effectiveModel =
			model ??
			botConfigForChat(chatId)?.defaultModel ??
			process.env["ANTHROPIC_MODEL"];
		const reply = effectiveModel
			? `Session reset. Model: ${effectiveModel}`
			: "Session reset.";
		await client.sendMessage(chatId, reply);
		return;
	}

	const callerName = msg.from.username ?? msg.from.first_name ?? "unknown";
	const caller = { name: callerName, source: "telegram" as const };

	// Active container → pipe follow-up
	const state = containers.get(chatId);
	if (state) {
		state.lastActivity = Date.now();
		writeIpcInput(chatId, state.containerName, text, caller);
		startTyping(chatId);
		await client.sendChatAction(chatId);
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

// --- Polling loop per bot ---
async function pollBot(client: TelegramClient): Promise<void> {
	let offset: number | undefined;
	log.info({ bot: client.name }, "Starting Telegram polling...");

	while (true) {
		try {
			const updates = await client.getUpdates(offset);
			for (const update of updates) {
				offset = update.update_id + 1;
				try {
					await handleMessage(update, client, client.allowedUserId);
				} catch (err) {
					log.error(
						{ err, update_id: update.update_id, bot: client.name },
						"Error handling message",
					);
				}
			}
		} catch (err) {
			log.error(
				{ err, bot: client.name },
				"Telegram polling error, retrying in 5s",
			);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

// --- Main ---
async function main(): Promise<void> {
	log.info("PicoClaw starting...");

	await cleanupOrphanedContainers();

	// Set commands for all bots
	for (const client of clients) {
		await client.setMyCommands([
			{ command: "new", description: "New session (/new opus, /new sonnet)" },
		]);
	}

	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

	// Collect all allowed user IDs
	const allAllowedUserIds = botConfigs.map((c) => c.allowedUserId);

	// Start subsystems
	startIpcWatcher({
		getAllowedChatId: () => allAllowedUserIds.join(","),
		readTasks,
		writeTasks,
		writeSnapshot: (chatId, tasks) =>
			writeTasksSnapshot(
				chatId,
				tasks as unknown as Array<Record<string, unknown>>,
			),
		sendMessage: dispatchMessage,
	});

	startTaskScheduler({
		readTasks,
		writeTasks,
		spawnEphemeral,
		sendMessage: dispatchMessage,
	});

	// Start parallel polling loops (one per bot)
	const pollers = clients.map((client) => pollBot(client));
	await Promise.all(pollers);
}

// Graceful shutdown
function shutdown(): void {
	log.info("Shutting down...");
	for (const [chatId, state] of containers) {
		log.info({ chatId }, "Closing container");
		writeCloseSentinel(chatId, state.containerName);
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
