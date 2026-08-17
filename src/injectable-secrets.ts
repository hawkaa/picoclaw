import fs from "node:fs";
import path from "node:path";
import pino from "pino";

import { DATA_DIR, PROJECT_ROOT } from "./config.ts";

const log = pino({ name: "injectable-secrets" });

/**
 * A whitelist entry tells the host WHERE a secret's value comes from. The task
 * author only ever names a secret — never chooses its source. Shorthand string
 * form `"FOO"` is equivalent to `{ "env": "FOO" }`.
 */
type WhitelistEntry = string | { env: string } | { file: string };
type Whitelist = Record<string, WhitelistEntry>;

/**
 * Harness-managed env vars can never be requested by a task, even if a
 * whitelist misconfiguration lists them: injecting these would let an
 * agent-authored task hijack its own auth/model/routing. Reserved names fail
 * closed like any other unauthorized name.
 */
const RESERVED_NAMES = new Set<string>([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODEL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"MAX_THINKING_TOKENS",
	"AGENTLAIR_AAT",
]);

function whitelistPath(): string {
	return (
		process.env["PICOCLAW_INJECTABLE_SECRETS_FILE"] ??
		path.join(PROJECT_ROOT, "injectable-secrets.json")
	);
}

function auditLogPath(): string {
	return (
		process.env["PICOCLAW_SECRET_AUDIT_LOG"] ??
		path.join(DATA_DIR, "secret-injections.jsonl")
	);
}

/**
 * Read the host-side whitelist. A MISSING file means "nothing is injectable"
 * (empty whitelist). A file that exists but is malformed throws — a broken
 * whitelist must never silently degrade to "allow" or "deny-all-but-crash";
 * it fails closed with a clear error so the operator fixes it.
 */
function loadWhitelist(): Whitelist {
	const file = whitelistPath();
	if (!fs.existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		throw new Error(
			`injectable-secrets whitelist at ${file} is not valid JSON: ${
				(err as Error).message
			}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`injectable-secrets whitelist at ${file} must be a JSON object mapping name -> source`,
		);
	}
	return parsed as Whitelist;
}

function resolveEnv(name: string, envVar: string): string {
	const value = process.env[envVar];
	if (value === undefined || value === "") {
		throw new Error(
			`injectable secret "${name}" maps to env var ${envVar}, which is not set on the host`,
		);
	}
	return value;
}

function resolveEntryValue(name: string, entry: WhitelistEntry): string {
	if (typeof entry === "string") return resolveEnv(name, entry);
	if ("env" in entry) return resolveEnv(name, entry.env);
	if ("file" in entry) {
		if (!fs.existsSync(entry.file)) {
			throw new Error(
				`injectable secret "${name}" maps to file ${entry.file}, which does not exist`,
			);
		}
		// Trim a single trailing newline (common in `echo secret > file`) but
		// preserve any intentional internal whitespace.
		const value = fs.readFileSync(entry.file, "utf-8").replace(/\r?\n$/, "");
		if (!value) {
			throw new Error(
				`injectable secret "${name}" file ${entry.file} is empty`,
			);
		}
		return value;
	}
	throw new Error(
		`injectable secret "${name}" has an invalid whitelist entry (expected a string, {env}, or {file})`,
	);
}

export interface InjectionContext {
	chatId: string;
	label?: string | null | undefined;
	taskId?: string | null | undefined;
}

/**
 * Append a NAME-ONLY audit record. Values are never written — the audit log is
 * safe to read, ship, and diff. One line per resolved injection batch.
 */
function appendAudit(ctx: InjectionContext, names: string[]): void {
	const entry = {
		ts: new Date().toISOString(),
		chatId: ctx.chatId,
		taskId: ctx.taskId ?? null,
		label: ctx.label ?? null,
		names, // NEVER values
	};
	try {
		fs.mkdirSync(path.dirname(auditLogPath()), { recursive: true });
		fs.appendFileSync(auditLogPath(), `${JSON.stringify(entry)}\n`);
	} catch (err) {
		// A failed audit write must not silently allow an unaudited injection.
		throw new Error(
			`failed to write secret-injection audit entry: ${(err as Error).message}`,
		);
	}
}

/**
 * Resolve a task's declared secret NAMES into a name->value map to be merged
 * into the container's stdin secrets channel (which the agent-runner turns into
 * SDK env vars).
 *
 * THREAT MODEL — containers run agent-authored code, so injection is:
 *   - opt-in per task: only names the task lists in its `secrets` field are
 *     considered; a task that declares nothing gets nothing.
 *   - whitelisted host-side: a name absent from injectable-secrets.json is a
 *     HARD ERROR (fail closed) — never a silent skip. The task author names a
 *     secret; the host alone decides whether and from where it resolves.
 *   - reserved-name protected: harness-managed keys (auth/model/routing) can
 *     never be requested, even if the whitelist lists them.
 *   - audited by NAME only: values are never logged.
 *
 * MUST be called BEFORE the container process is spawned, so a rejected name
 * aborts the spawn instead of orphaning a running-but-stdin-starved container.
 * Throws on any unauthorized or unresolvable name.
 */
export function resolveInjectableSecrets(
	requested: string[],
	ctx: InjectionContext,
): Record<string, string> {
	const names = [...new Set(requested)].map((n) => n.trim()).filter(Boolean);
	if (names.length === 0) return {};

	const whitelist = loadWhitelist();
	const resolved: Record<string, string> = {};
	for (const name of names) {
		if (RESERVED_NAMES.has(name)) {
			throw new Error(
				`secret "${name}" is harness-managed and cannot be injected per task`,
			);
		}
		const entry = whitelist[name];
		if (entry === undefined) {
			throw new Error(
				`secret "${name}" is not in the injectable-secrets whitelist (${whitelistPath()}); ` +
					"add it host-side to allow injection (fail closed)",
			);
		}
		resolved[name] = resolveEntryValue(name, entry);
	}

	appendAudit(ctx, names);
	log.info(
		{ chatId: ctx.chatId, label: ctx.label ?? null, names },
		"Injected whitelisted host secrets into container",
	);
	return resolved;
}
