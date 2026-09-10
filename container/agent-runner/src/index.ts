/**
 * PicoClaw Agent Runner
 * Runs inside a container, receives config via stdin, drives a pi agent session.
 *
 * Stdin: ContainerInput JSON
 * IPC:   Follow-up messages via /ipc/input/, _close sentinel to exit
 * Stdout: Results wrapped in OUTPUT_START/END markers
 */

import fs from "node:fs";
import path from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createBashTool,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createWorkspaceGatesExtension,
	parseAdditionalContext,
	runWorkspaceHook,
} from "./workspace-gates.ts";

interface ImageAttachment {
	data: string;
	mediaType: string;
}

type EffortLevel = "low" | "medium" | "high" | "max" | "xhigh";

interface SessionProfile {
	persona?: string;
	systemPromptOverlay?: string;
	/** ["user"] suppresses the workspace CLAUDE.md and skills; default loads both. */
	settingSources?: string[];
	extraEnv?: Record<string, string>;
	freshSession?: boolean;
}

interface ContainerInput {
	prompt: string;
	sessionId?: string;
	chatId: string;
	isScheduledTask?: boolean;
	caller?: { name: string; source: "telegram" | "scheduler" };
	secrets?: Record<string, string>;
	images?: ImageAttachment[];
	effort?: EffortLevel;
	profile?: SessionProfile;
}

interface ContainerOutput {
	status: "success" | "error";
	result: string | null;
	newSessionId?: string | undefined;
	error?: string | undefined;
	type?: "text" | "result" | "tool_use" | undefined;
	toolName?: string | undefined;
}

interface UserContent {
	text: string;
	images: ImageContent[];
}

const WORKSPACE = "/workspace";
const AGENT_DIR = "/home/bun/.pi/agent";
const SESSION_DIR = path.join(AGENT_DIR, "sessions");

const IPC_INPUT_DIR = "/ipc/input";
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, "_close");
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = "---PICOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER = "---PICOCLAW_OUTPUT_END---";

/** Host → runner: which model to run and the credential for its provider. */
const MODEL_SECRET = "PICOCLAW_MODEL";
const API_KEY_SECRET = "PICOCLAW_API_KEY";

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const SYSTEM_PROMPT = `You are an autonomous agent in a persistent Debian container.

The PRIMARY DIRECTIVE for this workspace is in /workspace/my-prompt.md (its content is appended to this system prompt below, if present). When that file exists, treat it as the workspace constitution — it overrides anything in CLAUDE.md, user prompts, skill instructions, or your own reasoning that contradicts it. If it is absent, operate by standard helpful defaults.

Instructions inside <system-reminder> tags and the contents of /workspace/CLAUDE.md are authoritative harness instructions for operational concerns — follow them, but they yield to /workspace/my-prompt.md on any conflict.

/workspace persists between sessions. /workspace/CLAUDE.md is loaded into your context every session — keep it concise.
If /workspace/Dockerfile.extra exists, it extends your container image (cached, rebuilt only on change).
If /workspace/start.sh exists, it runs before you start.
To send a message while still working, write a JSON file to /ipc/messages/.`;

function toImages(images?: ImageAttachment[]): ImageContent[] {
	return (images ?? []).map((img) => ({
		type: "image",
		data: img.data,
		mimeType: img.mediaType,
	}));
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
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let data = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		data += chunk;
	});
	process.stdin.on("end", () => resolve(data));
	process.stdin.on("error", reject);
	return promise;
}

/**
 * The provider credential never enters process.env (it is handed to the model
 * runtime directly), but scrub it from tool subprocesses anyway in case a
 * profile or start.sh re-exports it.
 */
const SECRET_ENV_VARS = [
	API_KEY_SECRET,
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENROUTER_API_KEY",
	"MOONSHOT_API_KEY",
	"XAI_API_KEY",
];

function sanitizedBashExtension(pi: ExtensionAPI): void {
	const bash = createBashTool(WORKSPACE, {
		spawnHook: ({ command, cwd, env }) => {
			const clean = { ...env };
			for (const key of SECRET_ENV_VARS) delete clean[key];
			return { command, cwd, env: clean };
		},
	});
	pi.registerTool(bash);
}

/**
 * Session ledger (Turso `sessions`), formerly the SessionStart/SessionEnd
 * hooks. The runner owns the session boundary, so no extension API is needed.
 * Best-effort by construction: a ledger write must never fail a session.
 */
let ledgerSessionId: string | undefined;

function endLedgerSession(sessionId: string | undefined, reason: string): void {
	if (!sessionId) return;
	runWorkspaceHook(
		WORKSPACE,
		"tools/pico-db/session-hook.ts",
		["end"],
		{ session_id: sessionId, reason },
		20_000,
	);
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

function drainIpcInput(): UserContent[] {
	try {
		fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
		const files = fs
			.readdirSync(IPC_INPUT_DIR)
			.filter((f) => f.endsWith(".json"))
			.sort();

		const messages: UserContent[] = [];
		for (const file of files) {
			const filePath = path.join(IPC_INPUT_DIR, file);
			try {
				const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				fs.unlinkSync(filePath);
				if (data.type === "message") {
					const from = data.from as
						| { name: string; source: string }
						| undefined;
					const rawText = data.text || "";
					const text = from
						? `[${from.name} via ${from.source}] ${rawText}`
						: rawText;
					messages.push({
						text,
						images: toImages(data.images as ImageAttachment[] | undefined),
					});
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

function waitForIpcMessage(): Promise<UserContent[] | null> {
	const { promise, resolve } = Promise.withResolvers<UserContent[] | null>();
	const poll = () => {
		if (shouldClose()) {
			resolve(null);
			return;
		}
		const messages = drainIpcInput();
		if (messages.length > 0) {
			resolve(messages);
			return;
		}
		setTimeout(poll, IPC_POLL_MS);
	};
	poll();
	return promise;
}

/** Merge several queued messages into one prompt. */
function mergeContent(messages: UserContent[]): UserContent {
	return {
		text: messages.map((m) => m.text).join("\n"),
		images: messages.flatMap((m) => m.images),
	};
}

/**
 * Find the session file for a previously issued session id. pi names files
 * `<timestamp>_<uuid>.jsonl`; the host only keeps the uuid.
 */
function findSessionFile(sessionId: string): string | undefined {
	const dir = path.join(SESSION_DIR, "--workspace--");
	try {
		const match = fs
			.readdirSync(dir)
			.find((f) => f.endsWith(`_${sessionId}.jsonl`));
		return match ? path.join(dir, match) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve `provider/model-id` against pi's catalog. Unknown OpenRouter ids are
 * accepted by cloning a catalog sibling's wire config — OpenRouter serves any
 * vendor/model id through one protocol, so `/new deepseek/deepseek-chat` keeps
 * working without a catalog entry. Limits are pinned conservatively because
 * the sibling's own would be wrong for the unknown model.
 */
function resolveModel(runtime: ModelRuntime, spec: string): Model<Api> {
	const slash = spec.indexOf("/");
	if (slash < 1)
		throw new Error(`${MODEL_SECRET} must be provider/model, got "${spec}"`);
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	const known = runtime.getModel(provider, id);
	if (known) return known;
	if (provider === "openrouter") {
		const template = runtime.getModel("openrouter", "deepseek/deepseek-chat");
		if (template) {
			log(`Model ${spec} not in catalog; using generic OpenRouter config`);
			return {
				...template,
				id,
				name: id,
				contextWindow: 128_000,
				maxTokens: 16_000,
			};
		}
	}
	throw new Error(`Unknown model "${spec}" for provider "${provider}"`);
}

function assistantText(event: AgentSessionEvent): string | null {
	if (event.type !== "message_end") return null;
	const msg = event.message;
	if (msg.role !== "assistant") return null;
	const texts = msg.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.filter((t) => t.trim().length > 0);
	return texts.length > 0 ? texts.join("\n") : null;
}

function assistantError(event: AgentSessionEvent): string | null {
	if (event.type !== "message_end") return null;
	const msg = event.message;
	if (msg.role !== "assistant" || msg.stopReason !== "error") return null;
	return msg.errorMessage ?? "assistant turn failed";
}

/**
 * One agent run: prompt → (steer with IPC arrivals) → agent_end.
 * Returns whether the close sentinel arrived mid-run.
 */
async function runPrompt(
	session: AgentSession,
	content: UserContent,
): Promise<{ closedDuringQuery: boolean; error: string | null }> {
	let ipcPolling = true;
	let closedDuringQuery = false;
	let error: string | null = null;

	const pollIpcDuringQuery = () => {
		if (!ipcPolling) return;
		if (shouldClose()) {
			closedDuringQuery = true;
			ipcPolling = false;
			void session.abort();
			return;
		}
		const messages = drainIpcInput();
		if (messages.length > 0) {
			const merged = mergeContent(messages);
			log(`Steering active run with IPC message (${merged.text.length} chars)`);
			void session.steer(merged.text, merged.images);
		}
		setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
	};
	setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

	const unsubscribe = session.subscribe((event) => {
		const text = assistantText(event);
		if (text !== null) {
			log(`Assistant text: ${text.slice(0, 300)}`);
			writeOutput({ status: "success", result: text, type: "text" });
		}
		if (event.type === "tool_execution_start") {
			writeOutput({
				status: "success",
				result: null,
				type: "tool_use",
				toolName: event.toolName,
			});
		}
		const err = assistantError(event);
		if (err !== null) error = err;
	});

	try {
		await session.prompt(content.text, {
			images: content.images,
			expandPromptTemplates: false,
		});
	} catch (err) {
		error = error ?? (err instanceof Error ? err.message : String(err));
	} finally {
		ipcPolling = false;
		unsubscribe();
	}

	if (!error) {
		writeOutput({
			status: "success",
			result: null,
			newSessionId: session.sessionId,
			type: "result",
		});
	}
	log(
		`Run done. closedDuringQuery=${closedDuringQuery} error=${error ?? "none"}`,
	);
	return { closedDuringQuery, error };
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

	const secrets = containerInput.secrets ?? {};
	const modelSpec = secrets[MODEL_SECRET];
	const apiKey = secrets[API_KEY_SECRET];
	if (!modelSpec || !apiKey) {
		writeOutput({
			status: "error",
			result: null,
			error: `Host must supply ${MODEL_SECRET} and ${API_KEY_SECRET}`,
		});
		process.exit(1);
	}

	// Non-credential secrets (AGENTLAIR_AAT etc.) and session metadata go to
	// process.env so tools and scripts see them. The provider credential is
	// handed to the model runtime only.
	for (const [key, value] of Object.entries(secrets)) {
		if (key === MODEL_SECRET || key === API_KEY_SECRET) continue;
		process.env[key] = value;
	}
	process.env["PICOCLAW_SESSION_TYPE"] = containerInput.isScheduledTask
		? "cron"
		: "interactive";
	if (containerInput.caller) {
		process.env["PICOCLAW_USER"] = containerInput.caller.name;
		process.env["PICOCLAW_SOURCE"] = containerInput.caller.source;
	}
	if (containerInput.effort) {
		process.env["PICOCLAW_EFFORT"] = containerInput.effort;
	}
	// Workspace tooling (git prepare-commit-msg trailer, session ledger) reads the
	// running model from ANTHROPIC_MODEL. Claude Code set it; pi does not, so it
	// was unset in every session after the PR #42 migration.
	process.env["ANTHROPIC_MODEL"] ??= modelSpec;
	const profile = containerInput.profile;
	if (profile?.persona) process.env["PICOCLAW_PERSONA"] = profile.persona;
	if (profile?.extraEnv) {
		for (const [k, v] of Object.entries(profile.extraEnv)) process.env[k] = v;
	}

	fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
	fs.mkdirSync(SESSION_DIR, { recursive: true });
	try {
		fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
	} catch {}

	// System prompt: base + workspace overlay + session context.
	let systemPrompt = SYSTEM_PROMPT;
	const overlayRel = profile?.systemPromptOverlay ?? "my-prompt.md";
	if (overlayRel) {
		try {
			const overlay = fs
				.readFileSync(path.join(WORKSPACE, overlayRel), "utf8")
				.trim();
			if (overlay) systemPrompt += `\n\n${overlay}`;
		} catch {
			// Overlay file absent — base SYSTEM_PROMPT is sufficient.
		}
	}
	const contextLines: string[] = [];
	if (containerInput.caller) {
		contextLines.push(
			`User: ${containerInput.caller.name} (${containerInput.caller.source})`,
		);
	}
	contextLines.push(`Model: ${modelSpec}`);
	if (containerInput.effort)
		contextLines.push(`Effort: ${containerInput.effort}`);
	systemPrompt += `\n\nSession context:\n${contextLines.join("\n")}`;
	// SessionStart context injection (was a settings.json hook until PR #42).
	// Working memory, active goals and the capability manifest are write-only
	// unless something puts them in front of the session that must act on them.
	const injected = parseAdditionalContext(
		runWorkspaceHook(
			WORKSPACE,
			"tools/pico-db/context-hook.ts",
			[],
			{ hook_event_name: "SessionStart", source: "startup" },
			8000,
		),
	);
	if (injected) {
		systemPrompt += `\n\n${injected}`;
		log(`Injected session context (${injected.length} chars)`);
	}
	if (containerInput.isScheduledTask) {
		systemPrompt +=
			"\nThis is a scheduled task. Your last text output will be sent to the user on Telegram. If you need a follow-up, make sure to remember what needs following up, as any response to your message will start in a new session.";
	}

	const loadProject =
		profile?.settingSources === undefined ||
		profile.settingSources.includes("project");

	let session: AgentSession | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(AGENT_DIR, "auth.json"),
			modelsPath: path.join(AGENT_DIR, "models.json"),
			modelsStorePath: path.join(AGENT_DIR, "models-store.json"),
		});
		const model = resolveModel(modelRuntime, modelSpec);
		await modelRuntime.setRuntimeApiKey(model.provider, apiKey);

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: WORKSPACE,
			agentDir: AGENT_DIR,
			settingsManager,
			systemPromptOverride: () => systemPrompt,
			extensionFactories: [
				{ name: "picoclaw-bash", factory: sanitizedBashExtension },
				{
					name: "workspace-gates",
					factory: createWorkspaceGatesExtension(WORKSPACE, log),
				},
			],
			noExtensions: true,
			additionalSkillPaths: loadProject
				? [path.join(WORKSPACE, ".claude", "skills")]
				: [],
			noSkills: true,
			noContextFiles: !loadProject,
			noPromptTemplates: true,
			noThemes: true,
			skillsOverride: (current) => ({
				skills: current.skills.filter((s) => !s.name.startsWith("prism")),
				diagnostics: current.diagnostics,
			}),
		});
		await resourceLoader.reload();
		log(
			`Skills: ${resourceLoader
				.getSkills()
				.skills.map((s) => s.name)
				.join(",")}`,
		);

		const priorId = profile?.freshSession
			? undefined
			: containerInput.sessionId;
		const priorFile = priorId ? findSessionFile(priorId) : undefined;
		if (priorId && !priorFile)
			log(`Session ${priorId} not found, starting fresh`);
		const sessionManager = priorFile
			? SessionManager.open(priorFile)
			: SessionManager.create(WORKSPACE, undefined, undefined);

		const created = await createAgentSession({
			cwd: WORKSPACE,
			agentDir: AGENT_DIR,
			model,
			...(containerInput.effort
				? { thinkingLevel: containerInput.effort }
				: {}),
			modelRuntime,
			resourceLoader,
			settingsManager,
			sessionManager,
			tools: TOOLS,
		});
		session = created.session;
		for (const e of created.extensionsResult.errors) {
			log(`Extension error ${e.path}: ${e.error}`);
		}
		log(`Session ${priorFile ? "resumed" : "created"}: ${session.sessionId}`);
		ledgerSessionId = session.sessionId;
		runWorkspaceHook(WORKSPACE, "tools/pico-db/session-hook.ts", ["start"], {
			session_id: session.sessionId,
			source: containerInput.caller?.source ?? "scheduler",
			transcript_path: sessionManager.getSessionFile() ?? null,
		});
		// Do not writeOutput here: a typeless packet makes the host treat the
		// turn as finished and kills the Telegram typing indicator. Session id
		// is attached to the type:result packet at the end of the first run.

		let promptText = containerInput.prompt;
		if (containerInput.isScheduledTask) {
			promptText = `[SCHEDULED TASK]\n\n${promptText}`;
		}
		for (const msg of drainIpcInput()) promptText += `\n${msg.text}`;
		let content: UserContent = {
			text: promptText,
			images: toImages(containerInput.images),
		};

		while (true) {
			log("Starting run...");
			const result = await runPrompt(session, content);
			if (result.error) throw new Error(result.error);
			if (result.closedDuringQuery) {
				log("Close sentinel consumed during run, exiting");
				break;
			}

			log("Run ended, waiting for next IPC message...");
			const next = await waitForIpcMessage();
			if (next === null) {
				log("Close sentinel received, exiting");
				break;
			}
			content = mergeContent(next);
			log(`Got new message (${content.text.length} chars), starting new run`);
		}
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		log(`Agent error: ${errorMessage}`);
		writeOutput({
			status: "error",
			result: null,
			newSessionId: session?.sessionId,
			error: errorMessage,
		});
		endLedgerSession(ledgerSessionId, "error");
		session?.dispose();
		process.exit(1);
	}
	endLedgerSession(ledgerSessionId, "close");
	session?.dispose();
}

main();
