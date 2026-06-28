import { describe, expect, test } from "bun:test";

import { MODEL_ALIASES, resolveModelId } from "./config.ts";
import { type IpcDeps, processTaskIpc } from "./ipc.ts";
import type { ScheduledTask } from "./types.ts";

/**
 * These tests pin the behavior behind the fix: a scheduled task stores the
 * model string verbatim (e.g. "opus") and the alias is resolved at spawn time
 * via resolveModelId — not frozen when the task was defined. A task running
 * daily for months must therefore track whatever "opus" currently points at.
 */

describe("resolveModelId (spawn-time resolution)", () => {
	test("resolves an alias to its current target", () => {
		// Assert the logical mapping, not a hardcoded version string, so bumping
		// the alias target in config does not break this test.
		expect(resolveModelId("opus")).toBe(MODEL_ALIASES["opus"] as string);
		expect(resolveModelId("opus")).not.toBe("opus");
	});

	test("is case-insensitive", () => {
		expect(resolveModelId("OPUS")).toBe(MODEL_ALIASES["opus"] as string);
	});

	test("passes concrete model ids through unchanged (existing tasks)", () => {
		// Existing tasks already store a resolved id; resolving again must be a
		// no-op so they keep working.
		expect(resolveModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
	});

	test("is idempotent — resolving twice equals resolving once", () => {
		const once = resolveModelId("opus");
		expect(resolveModelId(once)).toBe(once);
	});

	test("passes unknown strings through (original syntax keeps working)", () => {
		expect(resolveModelId("claude-some-future-model")).toBe(
			"claude-some-future-model",
		);
	});
});

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

function schedule(deps: IpcDeps, model: string | undefined): void {
	processTaskIpc(
		{
			type: "schedule",
			prompt: "daily report",
			schedule_type: "cron",
			schedule_value: "0 9 * * *",
			...(model !== undefined ? { model } : {}),
		},
		"chat-1",
		deps,
	);
}

describe("processTaskIpc (definition-time storage)", () => {
	test("stores an alias verbatim — does NOT freeze it to a version", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, "opus");
		const [task] = tasks();
		expect(task?.model).toBe("opus");
	});

	test("stored alias resolves to the current target at spawn time", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, "opus");
		const [task] = tasks();
		// Simulates what spawnContainer does just before launching the container.
		expect(resolveModelId(task?.model as string)).toBe(
			MODEL_ALIASES["opus"] as string,
		);
	});

	test("stores a concrete model id verbatim (original syntax still works)", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, "claude-opus-4-8");
		const [task] = tasks();
		expect(task?.model).toBe("claude-opus-4-8");
	});

	test("leaves model undefined when none is provided", () => {
		const { deps, tasks } = makeDeps();
		schedule(deps, undefined);
		const [task] = tasks();
		expect(task?.model).toBeUndefined();
	});

	test("upsert by label updates the alias without resolving it", () => {
		const { deps, tasks } = makeDeps();
		processTaskIpc(
			{
				type: "schedule",
				label: "report",
				prompt: "daily report",
				schedule_type: "cron",
				schedule_value: "0 9 * * *",
				model: "claude-opus-4-7",
			},
			"chat-1",
			deps,
		);
		processTaskIpc(
			{
				type: "schedule",
				label: "report",
				prompt: "daily report",
				schedule_type: "cron",
				schedule_value: "0 9 * * *",
				model: "opus",
			},
			"chat-1",
			deps,
		);
		expect(tasks()).toHaveLength(1);
		expect(tasks()[0]?.model).toBe("opus");
	});
});
