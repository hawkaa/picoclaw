import { type ChildProcess, exec, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import {
	CONTAINER_BASE_IMAGE,
	CONTAINER_DIR,
	CONTAINER_TIMEOUT,
	DATA_DIR,
	IDLE_TIMEOUT,
	OUTPUT_END_MARKER,
	OUTPUT_START_MARKER,
	type ProviderConfig,
	resolveModelTarget,
	SEEDS_DIR,
	WORKSPACES_DIR,
} from "./config.ts";
import type {
	ContainerInput,
	ContainerOutput,
	EffortLevel,
	ImageAttachment,
} from "./types.ts";

const log = pino({ name: "container-runner" });

function chatDir(chatId: string): string {
	return path.join(WORKSPACES_DIR, chatId);
}

/** Create directory (and parents) writable by the container user. */
function mkdirAll(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
	// mkdirSync mode only applies to newly created dirs; force it for existing ones
	fs.chmodSync(dir, 0o777);
}

/** Recursively chmod dirs to 777 and files to 666 so container user can write. */
function chmodRecursive(dir: string): void {
	fs.chmodSync(dir, 0o777);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			chmodRecursive(full);
		} else {
			fs.chmodSync(full, 0o666);
		}
	}
}

/**
 * Non-Anthropic backends don't understand the adaptive-thinking `effort`
 * beta the SDK sends for Claude models — they steer reasoning depth via the
 * Anthropic-protocol `thinking.budget_tokens`, which the Claude CLI derives
 * from MAX_THINKING_TOKENS (env wins over settings). OpenRouter maps that
 * budget onto the model's reasoning config, so `/new kimi high` actually
 * changes Kimi's thinking depth. Budgets are hard caps, not adaptive:
 * a too-low budget can truncate reasoning mid-thought on hard problems.
 */
export const PROVIDER_THINKING_BUDGETS: Record<EffortLevel, number> = {
	low: 2000,
	medium: 8000,
	high: 16000,
	max: 32000,
	xhigh: 32000,
};

export function readSecrets(
	anthropicApiKey: string,
	modelOverride?: string | undefined,
	provider?: ProviderConfig | undefined,
	effort?: EffortLevel | undefined,
): Record<string, string> {
	const secrets: Record<string, string> = {};
	const envModel = process.env["ANTHROPIC_MODEL"];
	if (envModel) secrets["ANTHROPIC_MODEL"] = envModel;
	if (provider) {
		// A provider may mint its credential instead of reading a host env var
		// (xAI: a short-lived OAuth token the official `grok` CLI keeps fresh).
		// The env var stays the documented fallback for both shapes.
		const providerKey =
			provider.resolveKey?.() ?? process.env[provider.apiKeyEnvVar];
		if (!providerKey) {
			throw new Error(
				provider.resolveKey
					? `Model routes to ${provider.baseUrl} but no credential is available — run \`grok login --device-auth\` on the host, or set ${provider.apiKeyEnvVar}`
					: `Model routes to ${provider.baseUrl} but ${provider.apiKeyEnvVar} is not set in the host environment`,
			);
		}
		secrets["ANTHROPIC_BASE_URL"] = provider.baseUrl;
		if (provider.authStyle === "auth-token") {
			secrets["ANTHROPIC_AUTH_TOKEN"] = providerKey;
			// OpenRouter's Anthropic skin requires ANTHROPIC_API_KEY to be
			// explicitly empty so the SDK doesn't fall back to it.
			secrets["ANTHROPIC_API_KEY"] = "";
		} else {
			secrets["ANTHROPIC_API_KEY"] = providerKey;
		}
		// Effort only maps to a thinking budget for provider-backed models;
		// Claude models keep the SDK's native adaptive-thinking effort.
		if (effort) {
			secrets["MAX_THINKING_TOKENS"] = String(
				PROVIDER_THINKING_BUDGETS[effort],
			);
		}
	} else if (anthropicApiKey.startsWith("sk-ant-oat")) {
		secrets["CLAUDE_CODE_OAUTH_TOKEN"] = anthropicApiKey;
	} else {
		secrets["ANTHROPIC_API_KEY"] = anthropicApiKey;
	}
	if (modelOverride) {
		secrets["ANTHROPIC_MODEL"] = modelOverride;
	}
	return secrets;
}

/**
 * Seed workspace with skills on first message.
 */
export function seedWorkspace(chatId: string): void {
	const workspaceDir = path.join(chatDir(chatId), "workspace");
	mkdirAll(workspaceDir);

	// Check if workspace is empty (no files other than CLAUDE.md)
	const existing = fs.readdirSync(workspaceDir);
	if (existing.length > 0) return;

	// Copy seeds into workspace
	if (fs.existsSync(SEEDS_DIR)) {
		fs.cpSync(SEEDS_DIR, workspaceDir, { recursive: true });
		// Make all seeded dirs/files writable by container user (uid 1000)
		chmodRecursive(workspaceDir);
		log.info({ chatId }, "Seeded workspace with skills");
	}
}

export function ensureSessionsDir(chatId: string): void {
	const sessionsDir = path.join(chatDir(chatId), "sessions");
	mkdirAll(sessionsDir);

	const settingsFile = path.join(sessionsDir, "settings.json");
	if (!fs.existsSync(settingsFile)) {
		fs.writeFileSync(
			settingsFile,
			`${JSON.stringify(
				{
					env: {
						CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
					},
				},
				null,
				2,
			)}\n`,
		);
	}
}

/**
 * Ensure IPC directories exist.
 */
export function ensureIpcDirs(chatId: string): void {
	const ipcDir = path.join(chatDir(chatId), "ipc");
	mkdirAll(path.join(ipcDir, "messages"));
	mkdirAll(path.join(ipcDir, "tasks"));
	mkdirAll(path.join(ipcDir, "input"));
	mkdirAll(path.join(ipcDir, "prayers"));
}

/**
 * Check if per-chat image needs rebuild (Dockerfile.extra changed).
 */
function getDockerfileExtraHash(chatId: string): string | null {
	const extraPath = path.join(chatDir(chatId), "workspace", "Dockerfile.extra");
	if (!fs.existsSync(extraPath)) return null;
	const content = fs.readFileSync(extraPath, "utf-8");
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function readImageHashes(): Record<string, string> {
	const hashFile = path.join(DATA_DIR, "image-hashes.json");
	if (!fs.existsSync(hashFile)) return {};
	try {
		return JSON.parse(fs.readFileSync(hashFile, "utf-8"));
	} catch {
		return {};
	}
}

function writeImageHashes(hashes: Record<string, string>): void {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(DATA_DIR, "image-hashes.json"),
		JSON.stringify(hashes, null, 2),
	);
}

/**
 * Build per-chat image if Dockerfile.extra exists and changed.
 * Returns the image name to use.
 */
export async function resolveImage(chatId: string): Promise<string> {
	const currentHash = getDockerfileExtraHash(chatId);
	if (!currentHash) return CONTAINER_BASE_IMAGE;

	const hashes = readImageHashes();
	const perChatImage = `picoclaw-${chatId}:latest`;

	if (hashes[chatId] === currentHash) return perChatImage;

	// Build per-chat image
	const extraContent = fs.readFileSync(
		path.join(chatDir(chatId), "workspace", "Dockerfile.extra"),
		"utf-8",
	);
	const dockerfile = `FROM ${CONTAINER_BASE_IMAGE}\nUSER root\n${extraContent}\nUSER bun`;
	const tmpDockerfile = path.join(chatDir(chatId), ".Dockerfile.build");
	fs.writeFileSync(tmpDockerfile, dockerfile);

	log.info({ chatId, hash: currentHash }, "Building per-chat image");

	await new Promise<void>((resolve, reject) => {
		exec(
			`docker build -f ${tmpDockerfile} -t ${perChatImage} ${CONTAINER_DIR}`,
			(err, _stdout, stderr) => {
				try {
					fs.unlinkSync(tmpDockerfile);
				} catch {}
				if (err) {
					log.error({ err, stderr }, "Per-chat image build failed");
					reject(err);
				} else {
					resolve();
				}
			},
		);
	});

	hashes[chatId] = currentHash;
	writeImageHashes(hashes);
	log.info({ chatId, image: perChatImage }, "Per-chat image built");

	// Rebuilding onto the same `:latest` tag untags the previous image, which then
	// sits on disk forever as a dangling layer set. Per-chat images are large
	// (a Dockerfile.extra with chromium + rust + foundry + node measured 4.4 GB on
	// 2026-07-30), so a few edits fill the containerd filesystem — at which point
	// every container fails on `mkdir /tmp/...: ENOSPC` and the whole host wedges.
	// `image prune -f` only touches untagged images no container references, so a
	// concurrently running session cannot lose its image.
	exec("docker image prune -f", { timeout: 120_000 }, (err, stdout) => {
		if (err) log.warn({ err }, "Dangling image prune failed");
		else
			log.info(
				{ reclaimed: stdout.trim().split("\n").pop() },
				"Pruned dangling images",
			);
	});

	return perChatImage;
}

/**
 * On host startup: stop any picoclaw containers left over from a previous run.
 */
export async function cleanupOrphanedContainers(): Promise<void> {
	return new Promise((resolve) => {
		exec(
			"docker ps --filter name=picoclaw- --format {{.Names}}",
			{ timeout: 10_000 },
			(err, stdout) => {
				if (err || !stdout.trim()) {
					resolve();
					return;
				}
				const names = stdout.trim().split("\n").filter(Boolean);
				if (names.length === 0) {
					resolve();
					return;
				}
				log.info({ containers: names }, "Stopping orphaned containers");
				exec(`docker stop ${names.join(" ")}`, { timeout: 30_000 }, () =>
					resolve(),
				);
			},
		);
	});
}

export async function spawnContainer(
	chatId: string,
	input: ContainerInput,
	onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{
	proc: ChildProcess;
	containerName: string;
	result: Promise<ContainerOutput>;
}> {
	const image = await resolveImage(chatId);
	const base = chatDir(chatId);
	const now = Date.now();
	const containerName = `picoclaw-${chatId}-${now}`;

	// Per-session log file (renamed to include session ID once known)
	const logsDir = path.join(base, "logs");
	fs.mkdirSync(logsDir, { recursive: true });
	const logTs = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
	let currentLogFile = path.join(logsDir, `${logTs}.log`);
	const logStream = fs.createWriteStream(currentLogFile, { flags: "a" });
	const writeLog = (line: string) => logStream.write(`${line}\n`);

	let logRenamed = false;
	const renameLogWithSession = (sessionId: string) => {
		if (logRenamed) return;
		logRenamed = true;
		const shortId = sessionId.slice(0, 8);
		const newLogFile = path.join(logsDir, `${logTs}-${shortId}.log`);
		try {
			fs.renameSync(currentLogFile, newLogFile);
			currentLogFile = newLogFile;
			log.info({ chatId, logFile: newLogFile }, "Log renamed with session ID");
		} catch (err) {
			log.warn({ err }, "Failed to rename log file");
		}
	};

	// Per-container input directory so scheduled and interactive containers don't
	// share the same /ipc/input and steal each other's messages.
	const containerInputDir = path.join(base, "ipc", "input", containerName);
	mkdirAll(containerInputDir);

	const args = [
		"run",
		"-i",
		"--rm",
		"--name",
		containerName,
		"-v",
		`${path.join(base, "workspace")}:/workspace`,
		"-v",
		`${path.join(base, "sessions")}:/home/bun/.claude`,
		"-v",
		`${path.join(base, "ipc")}:/ipc`,
		"-v",
		`${containerInputDir}:/ipc/input`,
		"-v",
		`${path.join(base, "logs")}:/logs:ro`,
		"-v",
		`${path.join(CONTAINER_DIR, "agent-runner", "src")}:/app/src:ro`,
		image,
	];

	const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

	writeLog(`=== Session start: ${containerName} ===`);
	writeLog(`=== prompt: ${input.prompt?.slice(0, 200)} ===`);
	log.info({ chatId, logFile: currentLogFile }, "Container session started");

	// Resolve model aliases (e.g. "opus") lazily at spawn time rather than at
	// task-definition time, so a long-lived scheduled task always targets the
	// current alias mapping instead of a version frozen when it was created.
	// Idempotent for concrete IDs (passthrough), so existing tasks/sessions
	// that already stored a resolved model keep working unchanged.
	// Provider-backed aliases (e.g. "k3") additionally carry an
	// Anthropic-compatible endpoint config that is injected as env vars —
	// same harness, different backend.
	let provider: ProviderConfig | undefined;
	if (input.model) {
		const target = resolveModelTarget(input.model);
		input.model = target.model;
		provider = target.provider;
	}

	// Pass secrets via stdin
	input.secrets = readSecrets(
		input.anthropicApiKey!,
		input.model,
		provider,
		input.effort,
	);
	input.anthropicApiKey = undefined;
	// Inject AgentLair AAT if issued by the host
	if (input.agentlairAAT) {
		input.secrets["AGENTLAIR_AAT"] = input.agentlairAAT;
		input.agentlairAAT = undefined;
	}
	proc.stdin?.write(JSON.stringify(input));
	proc.stdin?.end();
	input.secrets = undefined;

	const result = new Promise<ContainerOutput>((resolve) => {
		let stdout = "";
		let parseBuffer = "";
		let newSessionId: string | undefined;
		let hadStreamingOutput = false;
		let outputChain = Promise.resolve();

		// Idle timer (reset on output) bounded by an absolute hard deadline that
		// never moves: an agent that keeps emitting output can no longer keep a
		// container alive past CONTAINER_TIMEOUT. The prior single reset-able timer
		// had no ceiling, so active/looping sessions never timed out (orphan leak).
		const hardDeadline = Date.now() + CONTAINER_TIMEOUT;
		let timedOut = false;

		const killOnTimeout = () => {
			timedOut = true;
			log.warn({ chatId, containerName }, "Container timeout, stopping");
			exec(`docker stop ${containerName}`, { timeout: 15_000 }, (err) => {
				if (err) proc.kill("SIGKILL");
			});
		};

		const nextTimeoutMs = () =>
			Math.max(0, Math.min(IDLE_TIMEOUT, hardDeadline - Date.now()));
		let timeout = setTimeout(killOnTimeout, nextTimeoutMs());
		const resetTimeout = () => {
			clearTimeout(timeout);
			timeout = setTimeout(killOnTimeout, nextTimeoutMs());
		};

		proc.stdout?.on("data", (data: Buffer) => {
			const chunk = data.toString();
			stdout += chunk;
			writeLog(chunk.trimEnd());

			if (onOutput) {
				parseBuffer += chunk;
				for (
					let startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER);
					startIdx !== -1;
					startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)
				) {
					const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
					if (endIdx === -1) break;

					const jsonStr = parseBuffer
						.slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
						.trim();
					parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

					try {
						const parsed: ContainerOutput = JSON.parse(jsonStr);
						if (parsed.newSessionId) {
							newSessionId = parsed.newSessionId;
							renameLogWithSession(parsed.newSessionId);
						}
						hadStreamingOutput = true;
						resetTimeout();
						outputChain = outputChain.then(() => onOutput(parsed));
					} catch (err) {
						log.warn({ err }, "Failed to parse streamed output");
					}
				}
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			const lines = data.toString().trim().split("\n");
			for (const line of lines) {
				if (!line) continue;
				writeLog(line);
				// [agent-runner] lines are normal operational output; anything else
				// (raw Claude Code stderr) is surfaced at warn so crashes are visible.
				if (line.startsWith("[agent-runner]")) {
					log.info({ chatId }, line);
				} else {
					log.warn({ chatId }, line);
				}
			}
		});

		proc.on("close", (code) => {
			clearTimeout(timeout);
			writeLog(`=== Session end: exit code ${code} ===`);
			logStream.end();

			if (timedOut && hadStreamingOutput) {
				outputChain.then(() =>
					resolve({ status: "success", result: null, newSessionId }),
				);
				return;
			}
			if (timedOut) {
				resolve({
					status: "error",
					result: null,
					error: "Container timed out",
				});
				return;
			}
			if (code !== 0) {
				resolve({
					status: "error",
					result: null,
					error: `Container exited with code ${code}`,
				});
				return;
			}

			if (onOutput) {
				outputChain.then(() =>
					resolve({ status: "success", result: null, newSessionId }),
				);
				return;
			}

			// Non-streaming fallback: parse last output marker
			const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
			const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
			if (startIdx !== -1 && endIdx !== -1) {
				try {
					const parsed = JSON.parse(
						stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim(),
					);
					resolve(parsed);
					return;
				} catch {}
			}
			resolve({ status: "success", result: null, newSessionId });
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			resolve({
				status: "error",
				result: null,
				error: `Spawn error: ${err.message}`,
			});
		});
	});

	return { proc, containerName, result };
}

/**
 * Write a follow-up message to a specific container's IPC input directory.
 */
export function writeIpcInput(
	chatId: string,
	containerName: string,
	text: string,
	from?: { name: string; source: string } | undefined,
	images?: ImageAttachment[] | undefined,
): void {
	const inputDir = path.join(chatDir(chatId), "ipc", "input", containerName);
	mkdirAll(inputDir);
	const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
	const payload: Record<string, unknown> = { type: "message", text };
	if (from) payload["from"] = from;
	if (images && images.length > 0) payload["images"] = images;
	fs.writeFileSync(path.join(inputDir, filename), JSON.stringify(payload));
}

/**
 * Write _close sentinel to signal a specific container to exit.
 */
export function writeCloseSentinel(
	chatId: string,
	containerName: string,
): void {
	const sentinelPath = path.join(
		chatDir(chatId),
		"ipc",
		"input",
		containerName,
		"_close",
	);
	fs.writeFileSync(sentinelPath, "");
}

/**
 * Absolute host path of the workspace mounted at /workspace inside a chat's
 * containers. Handed to host-side precondition checks so they can read the
 * same config the agent sees.
 */
export function workspaceDirFor(chatId: string): string {
	return path.join(chatDir(chatId), "workspace");
}

/**
 * Write tasks snapshot for the container to read.
 */
export function writeTasksSnapshot(
	chatId: string,
	tasks: Array<Record<string, unknown>>,
): void {
	const ipcDir = path.join(chatDir(chatId), "ipc");
	mkdirAll(ipcDir);
	fs.writeFileSync(path.join(ipcDir, "current_tasks.yaml"), formatYaml(tasks));
}

function formatYaml(data: unknown): string {
	// Simple YAML serialization for task snapshots
	if (Array.isArray(data)) {
		if (data.length === 0) return "[]";
		return data
			.map((item) =>
				Object.entries(item as Record<string, unknown>)
					.filter(([, v]) => v !== undefined)
					.map(
						([k, v], i) =>
							`${i === 0 ? "- " : "  "}${k}: ${v === null ? "null" : JSON.stringify(v)}`,
					)
					.join("\n"),
			)
			.join("\n");
	}
	return JSON.stringify(data, null, 2);
}
