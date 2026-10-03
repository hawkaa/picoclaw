import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import { audit } from "./audit-client.ts";
import { WORKSPACES_DIR } from "./config.ts";

const log = pino({
	name: "workspace-git",
	transport: { target: "pino-pretty" },
});

export interface CommitMeta {
	containerName?: string | undefined;
	caller?: { name: string; source: string } | undefined;
	prompt?: string | undefined;
	sessionId?: string | undefined;
	botApiKey?: string | undefined;
}

function gitDir(chatId: string): string {
	return path.join(WORKSPACES_DIR, chatId, ".workspace-git");
}

function workTree(chatId: string): string {
	return path.join(WORKSPACES_DIR, chatId, "workspace");
}

function gitArgs(chatId: string): string[] {
	return [`--git-dir=${gitDir(chatId)}`, `--work-tree=${workTree(chatId)}`];
}

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "picoclaw",
	GIT_COMMITTER_NAME: "picoclaw",
	GIT_AUTHOR_EMAIL: "picoclaw@local",
	GIT_COMMITTER_EMAIL: "picoclaw@local",
};

function gitSync(chatId: string, args: string[]): void {
	execFileSync("git", [...gitArgs(chatId), ...args], {
		env: gitEnv,
		stdio: "ignore",
	});
}

function gitAsync(chatId: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[...gitArgs(chatId), ...args],
			{ env: gitEnv },
			(err, stdout) => {
				if (err) reject(err);
				else resolve(stdout);
			},
		);
	});
}

/**
 * Paths never worth snapshotting: reinstallable deps, scratch space, model
 * weights. Snapshotting these filled the 59G volume (Oct 2026).
 */
const EXCLUDES = [
	".DS_Store",
	"node_modules/",
	"/tmp/",
	".cache/",
	"__pycache__/",
	".venv/",
	"*.gguf",
	"*.safetensors",
	"*.onnx",
	"*.pt",
	"*.ckpt",
];

/** Squash history once the packed object store exceeds this. */
const COMPACT_THRESHOLD_KIB = 3 * 1024 * 1024; // 3 GiB

function writeExcludes(chatId: string): void {
	const infoDir = path.join(gitDir(chatId), "info");
	fs.mkdirSync(infoDir, { recursive: true });
	fs.writeFileSync(path.join(infoDir, "exclude"), `${EXCLUDES.join("\n")}\n`);
}

async function objectStoreKiB(chatId: string): Promise<number> {
	const out = await gitAsync(chatId, ["count-objects", "-v"]);
	let total = 0;
	for (const line of out.split("\n")) {
		const [key, value] = line.split(": ");
		if (key === "size" || key === "size-pack" || key === "size-garbage")
			total += Number(value) || 0;
	}
	return total;
}

/**
 * Initialise a git repo for the workspace if it doesn't already exist.
 * Sync and idempotent — safe to call on every container start.
 */
export function ensureWorkspaceGit(chatId: string): void {
	const dir = gitDir(chatId);

	try {
		execFileSync("git", [`--git-dir=${dir}`, "rev-parse", "--git-dir"], {
			stdio: "ignore",
		});
		writeExcludes(chatId);
		return;
	} catch {
		// Not a repo yet — continue to init
	}

	try {
		gitSync(chatId, ["init"]);
		writeExcludes(chatId);

		// Initial commit (allow empty in case workspace is still empty)
		gitSync(chatId, ["add", "-A"]);
		gitSync(chatId, [
			"commit",
			"--allow-empty",
			"-m",
			"Initial workspace snapshot",
		]);

		log.info({ chatId }, "Workspace git repo initialised");
	} catch (err) {
		log.warn({ chatId, err }, "Failed to initialise workspace git");
	}
}

/**
 * Commit current workspace state. Fire-and-forget — errors are logged, never thrown.
 */
export async function commitWorkspace(
	chatId: string,
	meta?: CommitMeta | undefined,
): Promise<void> {
	try {
		await gitAsync(chatId, ["add", "-A"]);

		const status = await gitAsync(chatId, ["status", "--porcelain"]);
		if (!status.trim()) {
			log.debug({ chatId }, "No workspace changes to commit");
			return;
		}

		const lines = ["Auto-backup after session", ""];
		lines.push(`chatId: ${chatId}`);
		lines.push(`timestamp: ${new Date().toISOString()}`);
		if (meta?.containerName) lines.push(`container: ${meta.containerName}`);
		if (meta?.caller)
			lines.push(`caller: ${meta.caller.name} (${meta.caller.source})`);
		if (meta?.prompt) {
			const snippet =
				meta.prompt.length > 120
					? `${meta.prompt.slice(0, 120)}…`
					: meta.prompt;
			lines.push(`prompt: ${snippet}`);
		}

		await gitAsync(chatId, ["commit", "-m", lines.join("\n")]);
		log.info({ chatId }, "Workspace committed");

		// Audit: log git commit
		if (meta?.sessionId) {
			audit.event({
				sessionId: meta.sessionId,
				eventType: "git.commit",
				description: "Workspace auto-committed after session",
				metadata: {
					chatId,
					caller: meta.caller?.name ?? null,
				},
				botApiKey: meta.botApiKey,
			});
		}
	} catch (err) {
		log.warn({ chatId, err }, "Failed to commit workspace");
		return;
	}

	try {
		const kib = await objectStoreKiB(chatId);
		if (kib > COMPACT_THRESHOLD_KIB) {
			log.info({ chatId, kib }, "Workspace git over threshold, compacting");
			await compactHistory(chatId);
		}
	} catch (err) {
		log.warn({ chatId, err }, "Failed to check workspace git size");
	}
}

const compacting = new Set<string>();

/**
 * Squash all history into a single commit (re-applying excludes, so already
 * tracked junk is dropped) and garbage-collect. Triggered automatically when
 * the object store exceeds COMPACT_THRESHOLD_KIB.
 */
export async function compactHistory(chatId: string): Promise<void> {
	if (compacting.has(chatId)) return;
	compacting.add(chatId);
	try {
		const branch = (
			await gitAsync(chatId, ["symbolic-ref", "--short", "HEAD"])
		).trim();
		await gitAsync(chatId, ["checkout", "--orphan", "compact-tmp"]);
		await gitAsync(chatId, [
			"rm",
			"-r",
			"-q",
			"--cached",
			"--ignore-unmatch",
			".",
		]);
		await gitAsync(chatId, ["add", "-A"]);
		await gitAsync(chatId, [
			"commit",
			"--allow-empty",
			"-m",
			"Compacted workspace history",
		]);
		await gitAsync(chatId, ["branch", "-D", branch]);
		await gitAsync(chatId, ["branch", "-m", branch]);
		await gitAsync(chatId, ["reflog", "expire", "--expire=now", "--all"]);
		await gitAsync(chatId, ["gc", "--prune=now", "--quiet"]);
		log.info({ chatId }, "Workspace history compacted");
	} catch (err) {
		log.warn({ chatId, err }, "Failed to compact workspace history");
	} finally {
		compacting.delete(chatId);
	}
}
