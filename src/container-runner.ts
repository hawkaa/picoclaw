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
	SEEDS_DIR,
	WORKSPACES_DIR,
} from "./config.ts";
import type { ContainerInput, ContainerOutput } from "./types.ts";

const log = pino({ name: "container-runner" });

function chatDir(chatId: string): string {
	return path.join(WORKSPACES_DIR, chatId);
}

function readSecrets(): Record<string, string> {
	const secrets: Record<string, string> = {};
	for (const key of [
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_MODEL",
	]) {
		const val = process.env[key];
		if (val) secrets[key] = val;
	}
	return secrets;
}

/**
 * Seed workspace with skills on first message.
 */
export function seedWorkspace(chatId: string): void {
	const workspaceDir = path.join(chatDir(chatId), "workspace");
	fs.mkdirSync(workspaceDir, { recursive: true });

	// Check if workspace is empty (no files other than CLAUDE.md)
	const existing = fs.readdirSync(workspaceDir);
	if (existing.length > 0) return;

	// Copy seeds into workspace
	if (fs.existsSync(SEEDS_DIR)) {
		fs.cpSync(SEEDS_DIR, workspaceDir, { recursive: true });
		log.info({ chatId }, "Seeded workspace with skills");
	}
}

/**
 * Ensure sessions directory has settings.json for Claude SDK.
 */
/**
 * Wipe Claude session files so the next container starts a truly fresh session.
 * Preserves settings.json.
 */
export function clearSessionFiles(chatId: string): void {
	const sessionsDir = path.join(chatDir(chatId), "sessions");
	if (!fs.existsSync(sessionsDir)) return;
	fs.rmSync(sessionsDir, { recursive: true });
	log.info({ chatId }, "Session files cleared");
}

export function ensureSessionsDir(chatId: string): void {
	const sessionsDir = path.join(chatDir(chatId), "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

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
	fs.mkdirSync(path.join(ipcDir, "messages"), { recursive: true });
	fs.mkdirSync(path.join(ipcDir, "tasks"), { recursive: true });
	fs.mkdirSync(path.join(ipcDir, "input"), { recursive: true });
	fs.mkdirSync(path.join(ipcDir, "prayers"), { recursive: true });
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
		`${path.join(base, "logs")}:/logs:ro`,
		"-v",
		`${path.join(CONTAINER_DIR, "agent-runner", "src")}:/app/src:ro`,
		image,
	];

	const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

	writeLog(`=== Session start: ${containerName} ===`);
	writeLog(`=== prompt: ${input.prompt?.slice(0, 200)} ===`);
	log.info({ chatId, logFile: currentLogFile }, "Container session started");

	// Pass secrets via stdin
	input.secrets = readSecrets();
	proc.stdin?.write(JSON.stringify(input));
	proc.stdin?.end();
	input.secrets = undefined;

	const result = new Promise<ContainerOutput>((resolve) => {
		let stdout = "";
		let parseBuffer = "";
		let newSessionId: string | undefined;
		let hadStreamingOutput = false;
		let outputChain = Promise.resolve();

		const timeoutMs = Math.max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30_000);
		let timedOut = false;

		const killOnTimeout = () => {
			timedOut = true;
			log.warn({ chatId, containerName }, "Container timeout, stopping");
			exec(`docker stop ${containerName}`, { timeout: 15_000 }, (err) => {
				if (err) proc.kill("SIGKILL");
			});
		};

		let timeout = setTimeout(killOnTimeout, timeoutMs);
		const resetTimeout = () => {
			clearTimeout(timeout);
			timeout = setTimeout(killOnTimeout, timeoutMs);
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
 * Write a follow-up message to the container's IPC input directory.
 */
export function writeIpcInput(
	chatId: string,
	text: string,
	from?: { name: string; source: string } | undefined,
): void {
	const inputDir = path.join(chatDir(chatId), "ipc", "input");
	fs.mkdirSync(inputDir, { recursive: true });
	const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
	const payload: Record<string, unknown> = { type: "message", text };
	if (from) payload["from"] = from;
	fs.writeFileSync(path.join(inputDir, filename), JSON.stringify(payload));
}

/**
 * Write _close sentinel to signal container to exit.
 */
export function writeCloseSentinel(chatId: string): void {
	const sentinelPath = path.join(chatDir(chatId), "ipc", "input", "_close");
	fs.writeFileSync(sentinelPath, "");
}

/**
 * Write tasks snapshot for the container to read.
 */
export function writeTasksSnapshot(
	chatId: string,
	tasks: Array<Record<string, unknown>>,
): void {
	const ipcDir = path.join(chatDir(chatId), "ipc");
	fs.mkdirSync(ipcDir, { recursive: true });
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
