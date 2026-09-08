import { describe, expect, test } from "bun:test";

import { coercePrecondition, processTaskIpc } from "./ipc.ts";
import type { ScheduledTask } from "./types.ts";

function harness(initial: ScheduledTask[] = []) {
	let tasks = initial;
	return {
		get tasks() {
			return tasks;
		},
		deps: {
			getAllowedChatId: () => "chat-1",
			readTasks: () => tasks,
			writeTasks: (t: ScheduledTask[]) => {
				tasks = t;
			},
			writeSnapshot: () => {},
			sendMessage: async () => {},
		},
	};
}

const scheduleMsg = (extra: Record<string, unknown>) => ({
	type: "schedule",
	label: "email-check",
	prompt: "triage",
	schedule_type: "cron",
	schedule_value: "0 * * * *",
	...extra,
});

describe("coercePrecondition", () => {
	test("keeps a legal single check as a string", () => {
		expect(coercePrecondition("imap-work --messages=INBOX")).toBe(
			"imap-work --messages=INBOX",
		);
	});

	test("keeps a legal list as a list", () => {
		expect(
			coercePrecondition(["pickable-task opus", "heartbeat-stale x 60"]),
		).toEqual(["pickable-task opus", "heartbeat-stale x 60"]);
	});

	test("empty string / empty array clear the gate", () => {
		expect(coercePrecondition("")).toBeUndefined();
		expect(coercePrecondition([])).toBeUndefined();
		expect(coercePrecondition(undefined)).toBeUndefined();
	});

	test("an illegal check name degrades to 'always spawn', never to 'never spawn'", () => {
		// The dangerous failure is a task that silently stops running. A gate we
		// cannot execute must therefore be dropped, not stored.
		expect(coercePrecondition("../../bin/sh")).toBeUndefined();
		expect(coercePrecondition(["imap-work", "; rm -rf /"])).toBeUndefined();
	});
});

describe("processTaskIpc — precondition plumbing", () => {
	test("schedule stores the precondition", () => {
		const h = harness();
		processTaskIpc(
			scheduleMsg({ precondition: "imap-work --messages=INBOX" }),
			"chat-1",
			h.deps,
		);
		expect(h.tasks[0]?.precondition).toBe("imap-work --messages=INBOX");
	});

	test("schedule upsert by label replaces the precondition", () => {
		const h = harness();
		processTaskIpc(
			scheduleMsg({ precondition: "imap-work" }),
			"chat-1",
			h.deps,
		);
		processTaskIpc(
			scheduleMsg({
				precondition: ["imap-work", "heartbeat-stale tmp/hb 3600"],
			}),
			"chat-1",
			h.deps,
		);
		expect(h.tasks.length).toBe(1);
		expect(h.tasks[0]?.precondition).toEqual([
			"imap-work",
			"heartbeat-stale tmp/hb 3600",
		]);
	});

	test("update sets, and an empty string clears, the gate", () => {
		const h = harness();
		processTaskIpc(scheduleMsg({}), "chat-1", h.deps);
		const id = h.tasks[0]?.id ?? "";
		expect(h.tasks[0]?.precondition).toBeUndefined();

		processTaskIpc(
			{
				type: "update",
				taskId: id,
				precondition: "imap-work --messages=INBOX",
			},
			"chat-1",
			h.deps,
		);
		expect(h.tasks[0]?.precondition).toBe("imap-work --messages=INBOX");

		processTaskIpc(
			{ type: "update", taskId: id, precondition: "" },
			"chat-1",
			h.deps,
		);
		expect(h.tasks[0]?.precondition).toBeUndefined();
	});

	test("an update that does not mention precondition leaves it alone", () => {
		const h = harness();
		processTaskIpc(
			scheduleMsg({ precondition: "imap-work" }),
			"chat-1",
			h.deps,
		);
		const id = h.tasks[0]?.id ?? "";
		processTaskIpc(
			{ type: "update", taskId: id, prompt: "new prompt" },
			"chat-1",
			h.deps,
		);
		expect(h.tasks[0]?.prompt).toBe("new prompt");
		expect(h.tasks[0]?.precondition).toBe("imap-work");
	});
});
