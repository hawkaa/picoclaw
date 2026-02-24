/**
 * PicoClaw Agent Runner
 * Runs inside a container, receives config via stdin, calls Claude Agent SDK.
 *
 * Stdin: ContainerInput JSON
 * IPC:   Follow-up messages via /ipc/input/, _close sentinel to exit
 * Stdout: Results wrapped in OUTPUT_START/END markers
 */

import fs from "node:fs";
import path from "node:path";
import {
	type HookCallback,
	type PreToolUseHookInput,
	query,
} from "@anthropic-ai/claude-agent-sdk";

interface ContainerInput {
	prompt: string;
	sessionId?: string;
	chatId: string;
	isScheduledTask?: boolean;
	caller?: { name: string; source: "telegram" | "scheduler" };
	secrets?: Record<string, string>;
}

interface ContainerOutput {
	status: "success" | "error";
	result: string | null;
	newSessionId?: string;
	error?: string;
}

interface SDKUserMessage {
	type: "user";
	message: { role: "user"; content: string };
	parent_tool_use_id: null;
	session_id: string;
}

const IPC_INPUT_DIR = "/ipc/input";
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, "_close");
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = "---PICOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER = "---PICOCLAW_OUTPUT_END---";

const SYSTEM_PROMPT = `You are a personal assistant running in a Debian container with bash and curl.
/workspace persists between sessions. /workspace/CLAUDE.md is loaded into your context every session — keep it concise.
If /workspace/Dockerfile.extra exists, it extends your container image (cached, rebuilt only on change).
If /workspace/start.sh exists, it runs before you start.
To send a message while still working, write a JSON file to /ipc/messages/.`;

class MessageStream {
	private queue: SDKUserMessage[] = [];
	private waiting: (() => void) | null = null;
	private done = false;
	sessionId = "";

	push(text: string): void {
		this.queue.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
			session_id: "",
		});
		this.waiting?.();
	}

	end(): void {
		this.done = true;
		this.waiting?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
		while (true) {
			while (this.queue.length > 0) {
				const msg = this.queue.shift()!;
				// Use the current session ID (set after system/init message arrives)
				msg.session_id = this.sessionId;
				yield msg;
			}
			if (this.done) return;
			await new Promise<void>((r) => {
				this.waiting = r;
			});
			this.waiting = null;
		}
	}
}

function writeOutput(output: ContainerOutput): void {
	console.log(OUTPUT_START_MARKER);
	console.log(JSON.stringify(output));
	console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
	console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

// Secrets to strip from Bash subprocesses
const SECRET_ENV_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

function createSanitizeBashHook(): HookCallback {
	return async (input, _toolUseId, _context) => {
		const preInput = input as PreToolUseHookInput;
		const command = (preInput.tool_input as { command?: string })?.command;
		if (!command) return {};

		const unsetPrefix = `unset ${SECRET_ENV_VARS.join(" ")} 2>/dev/null; `;
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				updatedInput: {
					...(preInput.tool_input as Record<string, unknown>),
					command: unsetPrefix + command,
				},
			},
		};
	};
}

function shouldClose(): boolean {
	if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
		try {
			fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
		} catch {}
		return true;
	}
	return false;
}

function drainIpcInput(): string[] {
	try {
		fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
		const files = fs
			.readdirSync(IPC_INPUT_DIR)
			.filter((f) => f.endsWith(".json"))
			.sort();

		const messages: string[] = [];
		for (const file of files) {
			const filePath = path.join(IPC_INPUT_DIR, file);
			try {
				const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				fs.unlinkSync(filePath);
				if (data.type === "message" && data.text) {
					const from = data.from as
						| { name: string; source: string }
						| undefined;
					const text = from
						? `[${from.name} via ${from.source}] ${data.text}`
						: data.text;
					messages.push(text);
				}
			} catch (err) {
				log(
					`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
				);
				try {
					fs.unlinkSync(filePath);
				} catch {}
			}
		}
		return messages;
	} catch (err) {
		log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

function waitForIpcMessage(): Promise<string | null> {
	return new Promise((resolve) => {
		const poll = () => {
			if (shouldClose()) {
				resolve(null);
				return;
			}
			const messages = drainIpcInput();
			if (messages.length > 0) {
				resolve(messages.join("\n"));
				return;
			}
			setTimeout(poll, IPC_POLL_MS);
		};
		poll();
	});
}

async function runQuery(
	prompt: string,
	sessionId: string | undefined,
	sdkEnv: Record<string, string | undefined>,
	systemPrompt: string,
	resumeAt?: string,
): Promise<{
	newSessionId?: string;
	lastAssistantUuid?: string;
	closedDuringQuery: boolean;
}> {
	const stream = new MessageStream();
	stream.push(prompt);

	let ipcPolling = true;
	let closedDuringQuery = false;

	const pollIpcDuringQuery = () => {
		if (!ipcPolling) return;
		if (shouldClose()) {
			closedDuringQuery = true;
			stream.end();
			ipcPolling = false;
			return;
		}
		const messages = drainIpcInput();
		for (const text of messages) {
			log(`Piping IPC message into active query (${text.length} chars)`);
			stream.push(text);
		}
		setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
	};
	setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

	let newSessionId: string | undefined;
	let lastAssistantUuid: string | undefined;
	let resultCount = 0;
	// Accumulate all assistant text blocks as fallback when SDK result is empty
	const assistantTexts: string[] = [];

	for await (const message of query({
		prompt: stream,
		options: {
			cwd: "/workspace",
			resume: sessionId,
			resumeSessionAt: resumeAt,
			systemPrompt,
			allowedTools: [
				"Bash",
				"Read",
				"Write",
				"Edit",
				"Glob",
				"Grep",
				"WebSearch",
				"WebFetch",
				"Task",
				"TaskOutput",
				"TaskStop",
				"TodoWrite",
				"NotebookEdit",
			],
			env: sdkEnv,
			pathToClaudeCodeExecutable: "/usr/local/lib/claude-code/cli.js",
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			settingSources: ["project", "user"],
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [createSanitizeBashHook()] }],
			},
		},
	})) {
		if (message.type === "assistant") {
			if ("uuid" in message)
				lastAssistantUuid = (message as { uuid: string }).uuid;
			// Log assistant content for debugging (text blocks only, skip tool_use)
			const msg = message as { message?: { content?: unknown[] } };
			const textBlocks = (msg.message?.content ?? [])
				.filter(
					(b): b is { type: "text"; text: string } =>
						typeof b === "object" &&
						b !== null &&
						(b as { type: string }).type === "text",
				)
				.map((b) => b.text);
			if (textBlocks.length > 0) {
				const text = textBlocks.join("\n");
				log(`Assistant text: ${text.slice(0, 300)}`);
				assistantTexts.push(text);
			}
		}

		if (message.type === "system" && message.subtype === "init") {
			newSessionId = message.session_id;
			stream.sessionId = newSessionId;
			log(`Session initialized: ${newSessionId}`);
		}

		if (message.type === "result") {
			resultCount++;
			const textResult =
				"result" in message ? (message as { result?: string }).result : null;
			const stopReason =
				"stop_reason" in message
					? (message as { stop_reason?: string | null }).stop_reason
					: undefined;
			// Always use accumulated assistant text — the SDK result only contains the
			// last turn which may be skill bookkeeping instead of the real response.
			const allAssistantText = assistantTexts.join("\n\n");
			const finalResult = allAssistantText || null;
			log(
				`Result #${resultCount}: stop_reason=${stopReason}, textResult=${textResult ? `"${textResult.slice(0, 200)}"` : "null"}, assistantTexts=${assistantTexts.length} blocks (${allAssistantText.length} chars), finalResult=${finalResult ? `"${finalResult.slice(0, 200)}"` : "null"}`,
			);
			writeOutput({ status: "success", result: finalResult, newSessionId });
			assistantTexts.length = 0;
		}
	}

	ipcPolling = false;
	log(
		`Query done. Results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`,
	);
	return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
	let containerInput: ContainerInput;

	try {
		const stdinData = await readStdin();
		containerInput = JSON.parse(stdinData);
		log(`Received input for chat: ${containerInput.chatId}`);
	} catch (err) {
		writeOutput({
			status: "error",
			result: null,
			error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
		});
		process.exit(1);
	}

	// Build SDK env: merge secrets without touching process.env
	const sdkEnv: Record<string, string | undefined> = { ...process.env };
	for (const [key, value] of Object.entries(containerInput.secrets || {})) {
		sdkEnv[key] = value;
	}

	let sessionId = containerInput.sessionId;
	fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

	// Clean stale _close sentinel
	try {
		fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
	} catch {}

	// Build system prompt with caller identity
	let systemPrompt = SYSTEM_PROMPT;
	if (containerInput.caller) {
		systemPrompt += `\nSession started by: ${containerInput.caller.name} (via ${containerInput.caller.source})`;
	}

	// Build initial prompt
	let prompt = containerInput.prompt;
	if (containerInput.isScheduledTask) {
		prompt = `[SCHEDULED TASK]\n\n${prompt}`;
	}
	const pending = drainIpcInput();
	if (pending.length > 0) {
		prompt += `\n${pending.join("\n")}`;
	}

	// Query loop: run query → wait for IPC message → repeat
	let resumeAt: string | undefined;
	try {
		while (true) {
			log(`Starting query (session: ${sessionId || "new"})...`);

			const queryResult = await runQuery(
				prompt,
				sessionId,
				sdkEnv,
				systemPrompt,
				resumeAt,
			);
			if (queryResult.newSessionId) sessionId = queryResult.newSessionId;
			if (queryResult.lastAssistantUuid)
				resumeAt = queryResult.lastAssistantUuid;

			if (queryResult.closedDuringQuery) {
				log("Close sentinel consumed during query, exiting");
				break;
			}

			// Emit session update
			writeOutput({ status: "success", result: null, newSessionId: sessionId });

			log("Query ended, waiting for next IPC message...");
			const nextMessage = await waitForIpcMessage();
			if (nextMessage === null) {
				log("Close sentinel received, exiting");
				break;
			}

			log(`Got new message (${nextMessage.length} chars), starting new query`);
			prompt = nextMessage;
		}
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log(`Agent error: ${errorMessage}`);
		writeOutput({
			status: "error",
			result: null,
			newSessionId: sessionId,
			error: errorMessage,
		});
		process.exit(1);
	}
}

main();
