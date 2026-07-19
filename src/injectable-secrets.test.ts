import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInjectableSecrets } from "./injectable-secrets.ts";
import { type IpcDeps, processTaskIpc } from "./ipc.ts";
import type { ScheduledTask } from "./types.ts";

// Each test gets an isolated whitelist + audit log via the env-var overrides
// (PICOCLAW_INJECTABLE_SECRETS_FILE / PICOCLAW_SECRET_AUDIT_LOG), read at call
// time by the module — so nothing here touches the host's real files.
let tmpDir: string;
let whitelistFile: string;
let auditFile: string;

const ctx = { chatId: "chat-1", label: "smoke-task" } as const;

function writeWhitelist(obj: unknown): void {
	fs.writeFileSync(whitelistFile, JSON.stringify(obj));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pico-secrets-"));
	whitelistFile = path.join(tmpDir, "injectable-secrets.json");
	auditFile = path.join(tmpDir, "secret-injections.jsonl");
	process.env["PICOCLAW_INJECTABLE_SECRETS_FILE"] = whitelistFile;
	process.env["PICOCLAW_SECRET_AUDIT_LOG"] = auditFile;
});

afterEach(() => {
	delete process.env["PICOCLAW_INJECTABLE_SECRETS_FILE"];
	delete process.env["PICOCLAW_SECRET_AUDIT_LOG"];
	delete process.env["SMOKE_SOURCE_ENV"];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveInjectableSecrets — host-side whitelist gate", () => {
	test("a whitelisted name resolves from its env source", () => {
		process.env["SMOKE_SOURCE_ENV"] = "s3cr3t-value";
		writeWhitelist({ OPENROUTER_API_KEY: { env: "SMOKE_SOURCE_ENV" } });

		const injected = resolveInjectableSecrets(["OPENROUTER_API_KEY"], ctx);

		expect(injected).toEqual({ OPENROUTER_API_KEY: "s3cr3t-value" });
	});

	test("shorthand string entry is treated as an env var name", () => {
		process.env["SMOKE_SOURCE_ENV"] = "shorthand-value";
		writeWhitelist({ OPENROUTER_API_KEY: "SMOKE_SOURCE_ENV" });

		const injected = resolveInjectableSecrets(["OPENROUTER_API_KEY"], ctx);

		expect(injected["OPENROUTER_API_KEY"]).toBe("shorthand-value");
	});

	test("a file-sourced entry resolves and strips one trailing newline", () => {
		const secretFile = path.join(tmpDir, "token");
		fs.writeFileSync(secretFile, "file-token\n");
		writeWhitelist({ SOME_TOKEN: { file: secretFile } });

		const injected = resolveInjectableSecrets(["SOME_TOKEN"], ctx);

		expect(injected["SOME_TOKEN"]).toBe("file-token");
	});

	test("a NON-whitelisted name fails closed (hard error)", () => {
		writeWhitelist({ OPENROUTER_API_KEY: "SMOKE_SOURCE_ENV" });

		expect(() => resolveInjectableSecrets(["NOT_WHITELISTED"], ctx)).toThrow(
			/not in the injectable-secrets whitelist/,
		);
	});

	test("a harness-reserved name fails closed even if whitelisted", () => {
		// A whitelist misconfiguration must not let a task hijack its own auth.
		process.env["SMOKE_SOURCE_ENV"] = "attacker-controlled";
		writeWhitelist({ ANTHROPIC_API_KEY: "SMOKE_SOURCE_ENV" });

		expect(() => resolveInjectableSecrets(["ANTHROPIC_API_KEY"], ctx)).toThrow(
			/harness-managed/,
		);
	});

	test("a whitelisted name whose env source is unset fails closed", () => {
		writeWhitelist({ OPENROUTER_API_KEY: { env: "DEFINITELY_UNSET_ENV" } });

		expect(() => resolveInjectableSecrets(["OPENROUTER_API_KEY"], ctx)).toThrow(
			/not set on the host/,
		);
	});

	test("a missing whitelist file means nothing is injectable", () => {
		// No writeWhitelist() → file absent → every name is unauthorized.
		expect(() => resolveInjectableSecrets(["ANYTHING"], ctx)).toThrow(
			/not in the injectable-secrets whitelist/,
		);
	});

	test("no requested names is a no-op (never reads the whitelist)", () => {
		// Whitelist file intentionally absent; empty request must not touch it.
		expect(resolveInjectableSecrets([], ctx)).toEqual({});
	});

	test("audit log records NAMES only — never values", () => {
		process.env["SMOKE_SOURCE_ENV"] = "must-not-appear-in-audit";
		writeWhitelist({ OPENROUTER_API_KEY: { env: "SMOKE_SOURCE_ENV" } });

		resolveInjectableSecrets(["OPENROUTER_API_KEY"], ctx);

		const audit = fs.readFileSync(auditFile, "utf-8").trim();
		expect(audit).not.toContain("must-not-appear-in-audit");
		const entry = JSON.parse(audit) as {
			names: string[];
			label: string;
			chatId: string;
		};
		expect(entry.names).toEqual(["OPENROUTER_API_KEY"]);
		expect(entry.chatId).toBe("chat-1");
		expect(entry.label).toBe("smoke-task");
	});

	test("a failed (unauthorized) request writes NO audit entry", () => {
		writeWhitelist({ OPENROUTER_API_KEY: "SMOKE_SOURCE_ENV" });
		expect(() => resolveInjectableSecrets(["NOPE"], ctx)).toThrow();
		expect(fs.existsSync(auditFile)).toBe(false);
	});
});

// The task/cron `secrets` field must survive the IPC create/update round-trip
// so the scheduler can pass it to spawnContainer.
function makeDeps(): { deps: IpcDeps; tasks: () => ScheduledTask[] } {
	let store: ScheduledTask[] = [];
	return {
		deps: {
			getAllowedChatId: () => "chat-1",
			readTasks: () => store,
			writeTasks: (t) => {
				store = t;
			},
			writeSnapshot: () => {},
			sendMessage: async () => {},
		},
		tasks: () => store,
	};
}

describe("processTaskIpc — secrets field persistence", () => {
	test("create stores the declared secret names", () => {
		const { deps, tasks } = makeDeps();
		processTaskIpc(
			{
				type: "schedule",
				label: "inference-task",
				prompt: "run inference",
				schedule_type: "cron",
				schedule_value: "0 9 * * *",
				secrets: ["OPENROUTER_API_KEY"],
			},
			"chat-1",
			deps,
		);
		expect(tasks()[0]?.secrets).toEqual(["OPENROUTER_API_KEY"]);
	});

	test("update can add and then clear the secret names", () => {
		const { deps, tasks } = makeDeps();
		processTaskIpc(
			{
				type: "schedule",
				prompt: "run inference",
				schedule_type: "cron",
				schedule_value: "0 9 * * *",
			},
			"chat-1",
			deps,
		);
		const id = tasks()[0]?.id as string;

		processTaskIpc(
			{ type: "update", taskId: id, secrets: ["OPENROUTER_API_KEY"] },
			"chat-1",
			deps,
		);
		expect(tasks()[0]?.secrets).toEqual(["OPENROUTER_API_KEY"]);

		// An empty array clears the field (revert to no injectable secrets).
		processTaskIpc({ type: "update", taskId: id, secrets: [] }, "chat-1", deps);
		expect(tasks()[0]?.secrets).toBeUndefined();
	});
});
