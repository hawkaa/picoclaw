import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import { WORKSPACES_DIR } from "./config.ts";

const log = pino({
	name: "workspace-git",
	transport: { target: "pino-pretty" },
});

export interface CommitMeta {
	containerName?: string | undefined;
	caller?: { name: string; source: string } | undefined;
	prompt?: string | undefined;
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
 * Initialise a git repo for the workspace if it doesn't already exist.
 * Sync and idempotent — safe to call on every container start.
 */
export function ensureWorkspaceGit(chatId: string): void {
	const dir = gitDir(chatId);

	try {
		execFileSync("git", [`--git-dir=${dir}`, "rev-parse", "--git-dir"], {
			stdio: "ignore",
		});
		return;
	} catch {
		// Not a repo yet — continue to init
	}

	try {
		gitSync(chatId, ["init"]);

		// Write exclude file
		const excludePath = path.join(dir, "info", "exclude");
		fs.writeFileSync(excludePath, ".DS_Store\n");

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
	} catch (err) {
		log.warn({ chatId, err }, "Failed to commit workspace");
	}
}

/**
 * Squash all history into a single commit and garbage-collect.
 * For manual or threshold-triggered use — not wired into any automatic trigger.
 */
export async function compactHistory(chatId: string): Promise<void> {
	try {
		await gitAsync(chatId, ["checkout", "--orphan", "tmp"]);
		await gitAsync(chatId, ["add", "-A"]);
		await gitAsync(chatId, ["commit", "-m", "Compacted workspace history"]);
		await gitAsync(chatId, ["branch", "-D", "master"]);
		await gitAsync(chatId, ["branch", "-m", "master"]);
		await gitAsync(chatId, ["gc", "--prune=now"]);
		log.info({ chatId }, "Workspace history compacted");
	} catch (err) {
		log.warn({ chatId, err }, "Failed to compact workspace history");
	}
}
