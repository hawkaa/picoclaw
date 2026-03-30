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
	ImageAttachment,
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
// Tracks the timestamp of the last /new reset per chatId.
// Used to discard session writes from containers that started before the reset.
const sessionResets = new Map<string, number>();

const TYPING_INTERVAL = 4000;

// --- Streaming edit-in-place state ---
interface StreamingState {
	/** ID of the placeholder message being edited. */
	messageId: number;
	/** Full accumulated text so far (may be truncated in the Telegram message). */
	accumulatedText: string;
	/** Timestamp of the last successful edit, for throttling. */
	lastEditAt: number;
	/** Scheduled throttle timer, if one is pending. */
	pendingEdit: ReturnType<typeof setTimeout> | null;
}

/** One streaming session per chatId. Cleared on turn completion. */
const streamingStates = new Map<string, StreamingState>();

/** Minimum ms between editMessageText calls (Telegram rate limit: ~1/s per chat). */
const STREAM_EDIT_THROTTLE_MS = 500;

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

/**
 * Handle a streaming text chunk using edit-in-place.
 *
 * - First chunk: sends a new message and stores its ID.
 * - Subsequent chunks: accumulates text and throttles edits to one per
 *   STREAM_EDIT_THROTTLE_MS (Telegram rate limit is ~1 edit/s per chat).
 * - Falls back to dispatchMessage if the initial send fails.
 */
async function handleStreamingChunk(
	chatId: string,
	newText: string,
): Promise<void> {
	const client = clientsByChatId.get(chatId);
	const existing = streamingStates.get(chatId);

	if (!existing) {
		// First chunk — send initial message and store the message ID.
		if (client) {
			const messageId = await client.sendMessageForStream(chatId, newText);
			if (messageId !== null) {
				streamingStates.set(chatId, {
					messageId,
					accumulatedText: newText,
					lastEditAt: Date.now(),
					pendingEdit: null,
				});
				return;
			}
		}
		// No client or initial send failed — fall back to plain send.
		await dispatchMessage(chatId, newText);
		return;
	}

	// Accumulate the new chunk.
	existing.accumulatedText += `\n\n${newText}`;

	// If text overflowed what we can show in a single Telegram message,
	// finalize the streamed message and send the overflow as new message(s).
	if (existing.accumulatedText.length > 4000 && client) {
		if (existing.pendingEdit) {
			clearTimeout(existing.pendingEdit);
			existing.pendingEdit = null;
		}
		const fullText = existing.accumulatedText;
		streamingStates.delete(chatId);

		// Final edit: ensure the streamed message shows the first 4000 chars.
		try {
			await client.editMessageText(chatId, existing.messageId, fullText);
		} catch {
			// editMessageText truncates internally — best effort.
		}

		// Send everything beyond 4000 chars as new message(s).
		// dispatchMessage → sendMessage handles splitting at 4096 on newlines.
		const overflow = fullText.slice(4000).trimStart();
		if (overflow) {
			await dispatchMessage(chatId, overflow);
		}
		return;
	}

	// Throttled edit.
	if (existing.pendingEdit) return; // already scheduled

	const elapsed = Date.now() - existing.lastEditAt;
	const doEdit = async () => {
		existing.pendingEdit = null;
		const state = streamingStates.get(chatId);
		if (!state || !client) return;
		try {
			await client.editMessageText(
				chatId,
				state.messageId,
				state.accumulatedText,
			);
			state.lastEditAt = Date.now();
		} catch (err) {
			log.warn({ err, chatId }, "Streaming editMessageText failed");
		}
	};

	if (elapsed >= STREAM_EDIT_THROTTLE_MS) {
		await doEdit();
	} else {
		existing.pendingEdit = setTimeout(() => {
			doEdit().catch(() => {});
		}, STREAM_EDIT_THROTTLE_MS - elapsed);
	}
}

/**
 * Flush any pending streaming edit and clean up state for this chat.
 * Called when a turn completes (type:"result") or a container exits.
 */
async function finalizeStreaming(chatId: string): Promise<void> {
	const state = streamingStates.get(chatId);
	if (!state) return;

	// Cancel any scheduled edit.
	if (state.pendingEdit) {
		clearTimeout(state.pendingEdit);
		state.pendingEdit = null;
	}

	streamingStates.delete(chatId);

	const client = clientsByChatId.get(chatId);
	if (!client) return;

	// Perform a final edit to ensure the latest text is shown.
	try {
		await client.editMessageText(
			chatId,
			state.messageId,
			state.accumulatedText,
		);
	} catch (err) {
		log.warn({ err, chatId }, "Final streaming editMessageText failed");
	}

	// editMessageText truncates at 4000 chars. If accumulated text is longer,
	// send the overflow as new message(s) so no content is lost.
	if (state.accumulatedText.length > 4000) {
		const overflow = state.accumulatedText.slice(4000).trimStart();
		if (overflow) {
			await dispatchMessage(chatId, overflow);
		}
	}
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

	// Route text chunks through the streaming path; everything else uses plain send.
	if (output.type === "text" && output.result) {
		log.info(
			{
				chatId,
				resultLength: output.result.length,
				preview: output.result.slice(0, 200),
			},
			"Streaming text chunk to Telegram",
		);
		await handleStreamingChunk(chatId, output.result);
	} else if (output.result) {
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

	// Finalize streaming and stop typing on turn completion.
	if (output.type !== "text") {
		await finalizeStreaming(chatId);
		stopTyping(chatId);
	}

	// Reset idle timer on any output
	resetIdleTimer(chatId);
}

async function startContainer(
	chatId: string,
	prompt: string,
	caller?: { name: string; source: "telegram" | "scheduler" } | undefined,
	images?: ImageAttachment[] | undefined,
): Promise<void> {
	// Capture spawn time before any async work. Used to detect if /new was called
	// while this container was running (sessionResets[chatId] > spawnTime).
	const spawnTime = Date.now();

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
	const botConfig = botConfigForChat(chatId);
	const model = session?.model ?? botConfig?.defaultModel;
	const anthropicApiKey = botConfig?.anthropicApiKey;

	await dispatchChatAction(chatId);

	const { proc, containerName, result } = await spawnContainer(
		chatId,
		{ prompt, sessionId, chatId, caller, model, anthropicApiKey, images },
		async (output) => {
			// Drop output (including session writes) from containers that were
			// superseded by a /new reset after this container was spawned.
			if (spawnTime <= (sessionResets.get(chatId) ?? 0)) return;
			await handleOutput(chatId, output);
		},
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
		.then(async (finalOutput) => {
			containers.delete(chatId);
			// Flush any in-flight streaming state before stopping the typing indicator.
			await finalizeStreaming(chatId);
			stopTyping(chatId);
			const timer = idleTimers.get(chatId);
			if (timer) {
				clearTimeout(timer);
				idleTimers.delete(chatId);
			}

			if (
				finalOutput.newSessionId &&
				spawnTime > (sessionResets.get(chatId) ?? 0)
			) {
				// Only persist the new session ID if /new was NOT called after this
				// container started. Otherwise we'd restore a stale session that the
				// user explicitly cleared.
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

function inferMediaType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		default:
			return "image/jpeg";
	}
}

async function handleMessage(
	update: TelegramUpdate,
	client: TelegramClient,
	allowedUserId: string,
): Promise<void> {
	const msg = update.message;
	if (!msg?.from) return;
	// Accept messages with text or photo (or both via caption)
	if (!msg.text && !msg.photo) return;

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

	// Acknowledge receipt immediately with a reaction (fire-and-forget).
	// This gives Håkon instant visual feedback that the message was received,
	// before the agent container even starts.
	client.setMessageReaction(chatId, msg.message_id).catch(() => {});

	const text = (msg.text ?? msg.caption ?? "").trim();

	// Download photo if present
	let images: ImageAttachment[] | undefined;
	if (msg.photo && msg.photo.length > 0) {
		try {
			// Telegram provides multiple sizes; pick the largest within safe limits.
			// Anthropic API rejects images with dimensions > 8000px on either axis.
			const MAX_DIM = 7680;
			// Photos are sorted smallest → largest; iterate in reverse to find
			// the biggest one that fits within the dimension limit.
			const sorted = [...msg.photo].reverse();
			const chosen =
				sorted.find((p) => p.width <= MAX_DIM && p.height <= MAX_DIM) ??
				sorted[sorted.length - 1]; // fallback: use smallest if all are too large
			if (!chosen) throw new Error("Photo array unexpectedly empty");
			if (chosen.width > MAX_DIM || chosen.height > MAX_DIM) {
				log.warn(
					{ chatId, width: chosen.width, height: chosen.height, MAX_DIM },
					"Photo exceeds max dimension; using smallest available size",
				);
			}
			const fileInfo = await client.getFile(chosen.file_id);
			const buffer = await client.downloadFile(fileInfo.file_path);
			const mediaType = inferMediaType(fileInfo.file_path);
			images = [{ data: buffer.toString("base64"), mediaType }];
			log.info(
				{
					chatId,
					fileSize: buffer.length,
					mediaType,
					width: chosen.width,
					height: chosen.height,
				},
				"Downloaded Telegram photo",
			);
		} catch (err) {
			log.error({ err, chatId }, "Failed to download photo");
		}
	}

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
		// Record reset time so in-flight containers don't overwrite the cleared session.
		sessionResets.set(chatId, Date.now());
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
		writeIpcInput(chatId, state.containerName, text, caller, images);
		startTyping(chatId);
		await client.sendChatAction(chatId);
		return;
	}

	// No container → spawn new one
	await startContainer(chatId, text, caller, images);
}

// --- Ephemeral container for scheduled tasks ---
async function spawnEphemeral(
	chatId: string,
	prompt: string,
	task: {
		id: string;
		label?: string | undefined;
		model?: string | undefined;
		effort?: string | undefined;
	},
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

	const anthropicApiKey = botConfigForChat(chatId)?.anthropicApiKey;

	const MAX_ATTEMPTS = 2;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		// We use an onOutput callback so we can detect when the query
		// completes and signal the container to exit gracefully — this
		// gives Claude Code SessionEnd hooks a chance to fire.
		let sessionId: string | undefined;

		const { containerName, result } = await spawnContainer(
			chatId,
			{
				prompt,
				chatId,
				isScheduledTask: true,
				caller,
				model: task.model,
				effort: task.effort,
				anthropicApiKey,
			},
			async (output) => {
				if (output.newSessionId) sessionId = output.newSessionId;
				if (output.type === "result") {
					// Query complete — signal container to exit gracefully so
					// Claude Code SessionEnd hooks (e.g. session summaries) run.
					writeCloseSentinel(chatId, containerName);
				}
			},
		);

		const output = await result;

		// Detect pre-init crash: container exited with an error before any
		// session was initialized (~1-2% of sessions, intermittent SDK bug).
		// Retry once before reporting the error.
		const isPreInitCrash =
			output.status === "error" &&
			output.error?.includes("exited with code") &&
			!sessionId &&
			!output.newSessionId;

		if (isPreInitCrash && attempt < MAX_ATTEMPTS) {
			log.warn(
				{ chatId, taskId: task.id, attempt },
				"[task-scheduler] Session crashed before init, retrying (attempt %d/%d)",
				attempt + 1,
				MAX_ATTEMPTS,
			);
			continue;
		}

		await commitWorkspace(chatId, {
			caller,
			prompt,
		}).catch(() => {});

		return {
			...output,
			result: null,
			newSessionId: sessionId ?? output.newSessionId,
		};
	}

	// Unreachable, but satisfies TypeScript
	return { status: "error", result: null, error: "Exhausted retries" };
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
