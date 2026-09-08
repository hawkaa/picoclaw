import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import { PRECONDITION_TIMEOUT, PRECONDITIONS_DIR } from "./config.ts";

const log = pino({ name: "precondition" });

/**
 * Why a scheduled task can be skipped without spawning a container.
 *
 * - `passed`       — the check exited 0: there is work, spawn.
 * - `not-met`      — the check exited 1..254: nothing to do, skip the spawn.
 * - `unevaluable`  — the check could not be run or did not finish (missing
 *                    file, not executable, timeout, signal, exit 255).
 *                    FAIL OPEN: we spawn anyway.
 * - `no-check`     — the task has no precondition.
 * - `invalid`      — the precondition string is not a legal check name.
 *                    FAIL OPEN.
 */
export type PreconditionReason =
	| "passed"
	| "not-met"
	| "unevaluable"
	| "no-check"
	| "invalid";

export interface PreconditionOutcome {
	/** True → spawn the container. False → skip this firing. */
	shouldSpawn: boolean;
	reason: PreconditionReason;
	/** The check that decided it (absent for `no-check`). */
	check?: string | undefined;
	/** Process exit code, when the check ran to completion. */
	code?: number | null | undefined;
	/** Human-readable detail for the log line. */
	detail?: string | undefined;
}

/**
 * Exit-code contract, borrowed verbatim from systemd's `ExecCondition=`:
 *
 *   0        → condition holds, proceed
 *   1..254   → condition does not hold, skip (not an error)
 *   255      → the check itself failed
 *
 * Anything we cannot turn into one of those (spawn error, timeout, signal)
 * is treated like 255.
 *
 * FAIL-OPEN IS DELIBERATE. The expensive failure is not "we booted a
 * container we didn't need" (one boot), it is "a cron silently stopped
 * running because its check had a typo" (invisible, unbounded). A broken
 * check therefore costs tokens, never work.
 */
const SKIP_CODE_MIN = 1;
const SKIP_CODE_MAX = 254;

/**
 * A precondition names an executable in the host-owned `preconditions/`
 * directory — it is NOT a shell command.
 *
 * Scheduled tasks arrive over IPC, i.e. from inside a container. README:
 * "you need isolation so the agent can't reach the host". An arbitrary
 * shell string in tasks.json would hand every container (and anything that
 * successfully prompt-injects one) code execution on the host, outside the
 * sandbox. Naming a vetted, repo-resident check keeps that boundary: the
 * container chooses WHICH question to ask, never what code answers it.
 *
 * Arguments are passed as argv, never through a shell, so no quoting,
 * globbing or command substitution is possible.
 */
const CHECK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ParsedPrecondition {
	name: string;
	args: string[];
}

/** `"imap-work --messages=INBOX"` → `{ name, args }`. Null if illegal. */
export function parsePrecondition(spec: string): ParsedPrecondition | null {
	const parts = spec.trim().split(/\s+/).filter(Boolean);
	const [name, ...args] = parts;
	if (!name || !CHECK_NAME_RE.test(name)) return null;
	return { name, args };
}

/**
 * A task may carry one check or several. Several are OR-ed: the container is
 * spawned if ANY check says there is work. OR is the fail-open direction —
 * it is how a task expresses "spawn when the queue has work, and in any case
 * at least every N hours".
 */
export function normalizePreconditions(
	precondition: string | string[] | undefined,
): string[] {
	if (precondition === undefined) return [];
	const list = Array.isArray(precondition) ? precondition : [precondition];
	return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface RunCheckOptions {
	/** Absolute path of the workspace mounted into the task's container. */
	workspaceDir?: string | undefined;
	/** Override the executable directory (tests). */
	dir?: string | undefined;
	timeoutMs?: number | undefined;
}

/**
 * Run one check to completion. Never throws.
 */
export async function runCheck(
	spec: string,
	opts: RunCheckOptions = {},
): Promise<PreconditionOutcome> {
	const parsed = parsePrecondition(spec);
	if (!parsed) {
		return {
			shouldSpawn: true,
			reason: "invalid",
			detail: `not a legal check name: ${JSON.stringify(spec)}`,
		};
	}

	const dir = opts.dir ?? PRECONDITIONS_DIR;
	const file = path.join(dir, parsed.name);
	// path.join cannot escape `dir` here — the name is charset-validated and
	// contains no separators — but assert it anyway: this is a security
	// boundary, and a boundary that is only implied is a boundary nobody
	// re-checks when the regex is next edited.
	if (path.dirname(file) !== path.resolve(dir)) {
		return {
			shouldSpawn: true,
			reason: "invalid",
			check: parsed.name,
			detail: "resolved outside the preconditions directory",
		};
	}
	if (!fs.existsSync(file)) {
		return {
			shouldSpawn: true,
			reason: "unevaluable",
			check: parsed.name,
			detail: `no such check: ${file}`,
		};
	}

	const timeoutMs = opts.timeoutMs ?? PRECONDITION_TIMEOUT;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (opts.workspaceDir) env["PICOCLAW_WORKSPACE_DIR"] = opts.workspaceDir;

	return await new Promise<PreconditionOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: PreconditionOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};

		const child = spawn(file, parsed.args, {
			cwd: dir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < 2000) stderr += String(chunk);
		});
		// Drain stdout so a chatty check cannot block on a full pipe.
		child.stdout?.on("data", () => {});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({
				shouldSpawn: true,
				reason: "unevaluable",
				check: parsed.name,
				detail: `timed out after ${timeoutMs}ms`,
			});
		}, timeoutMs);

		child.on("error", (err) => {
			finish({
				shouldSpawn: true,
				reason: "unevaluable",
				check: parsed.name,
				detail: `spawn failed: ${err.message}`,
			});
		});

		child.on("close", (code, signal) => {
			if (signal !== null) {
				finish({
					shouldSpawn: true,
					reason: "unevaluable",
					check: parsed.name,
					detail: `killed by ${signal}`,
				});
				return;
			}
			if (code === 0) {
				finish({
					shouldSpawn: true,
					reason: "passed",
					check: parsed.name,
					code,
				});
				return;
			}
			if (code !== null && code >= SKIP_CODE_MIN && code <= SKIP_CODE_MAX) {
				finish({
					shouldSpawn: false,
					reason: "not-met",
					check: parsed.name,
					code,
					detail: stderr.trim().slice(0, 300) || undefined,
				});
				return;
			}
			finish({
				shouldSpawn: true,
				reason: "unevaluable",
				check: parsed.name,
				code,
				detail: stderr.trim().slice(0, 300) || `exit ${code}`,
			});
		});
	});
}

/**
 * Evaluate a task's precondition(s). Short-circuits on the first check that
 * says "spawn" — including a check that could not be evaluated.
 */
export async function evaluatePreconditions(
	precondition: string | string[] | undefined,
	opts: RunCheckOptions = {},
): Promise<PreconditionOutcome> {
	const specs = normalizePreconditions(precondition);
	if (specs.length === 0) return { shouldSpawn: true, reason: "no-check" };

	let last: PreconditionOutcome = { shouldSpawn: true, reason: "no-check" };
	for (const spec of specs) {
		last = await runCheck(spec, opts);
		if (last.shouldSpawn) return last;
	}
	return last;
}

/**
 * Scheduler-facing wrapper: evaluates and logs. The log line is the only
 * evidence a skip happened, so it carries the task id, the deciding check
 * and the exit code.
 */
export async function checkTaskPrecondition(
	task: {
		id: string;
		label?: string | undefined;
		precondition?: string | string[] | undefined;
	},
	opts: RunCheckOptions = {},
): Promise<PreconditionOutcome> {
	const started = Date.now();
	const outcome = await evaluatePreconditions(task.precondition, opts);
	const durationMs = Date.now() - started;
	if (outcome.reason === "no-check") return outcome;

	const fields = {
		taskId: task.id,
		label: task.label,
		check: outcome.check,
		code: outcome.code,
		durationMs,
		detail: outcome.detail,
	};
	if (outcome.reason === "not-met") {
		log.info(fields, "Precondition not met — container not spawned");
	} else if (outcome.reason === "passed") {
		log.debug(fields, "Precondition met");
	} else {
		log.warn(
			fields,
			"Precondition could not be evaluated — spawning anyway (fail open)",
		);
	}
	return outcome;
}
