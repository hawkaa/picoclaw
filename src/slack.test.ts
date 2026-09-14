import { describe, expect, test } from "bun:test";

import {
	dockerSafeId,
	parseLeadingModel,
	shouldIgnoreSlackEvent,
	slackRuntimeId,
} from "./slack.ts";

describe("slackRuntimeId", () => {
	test("is docker-safe and stable", () => {
		const id = slackRuntimeId("C0C14L10MN3", "1789361233.883059");
		expect(id).toBe("slack-C0C14L10MN3-1789361233-883059");
		expect(dockerSafeId(id)).toBe(id);
	});
});

describe("dockerSafeId", () => {
	test("strips colons and slashes", () => {
		expect(dockerSafeId("slack:C1:1.2")).toBe("slack-C1-1.2");
	});
});

describe("parseLeadingModel", () => {
	test("strips /new grok xhigh from the first line", () => {
		const p = parseLeadingModel("/new grok xhigh\nJOB 1 | OWNER: hakon");
		expect(p.model).toBe("grok");
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("JOB 1 | OWNER: hakon");
	});

	test("leaves ordinary text alone", () => {
		const p = parseLeadingModel("hello pico");
		expect(p.model).toBeUndefined();
		expect(p.rest).toBe("hello pico");
	});

	test("bare /new leaves empty rest", () => {
		const p = parseLeadingModel("/new grok xhigh");
		expect(p.model).toBe("grok");
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("");
	});
});

describe("shouldIgnoreSlackEvent", () => {
	const selfBot = "BSELF";
	const selfUser = "USELF";

	test("drops our own bot echoes", () => {
		expect(
			shouldIgnoreSlackEvent(
				{ type: "message", bot_id: selfBot, text: "hi" },
				selfBot,
				selfUser,
			),
		).toBe(true);
	});

	test("keeps a human message", () => {
		expect(
			shouldIgnoreSlackEvent(
				{ type: "message", user: "U0HAKON", text: "hi" },
				selfBot,
				selfUser,
			),
		).toBe(false);
	});

	test("keeps another bot (Picolino) and drops non-message subtypes", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					subtype: "bot_message",
					bot_id: "BOTHER",
					text: "hi",
				},
				selfBot,
				selfUser,
			),
		).toBe(false);
		expect(
			shouldIgnoreSlackEvent(
				{ type: "message", subtype: "message_changed", text: "hi" },
				selfBot,
				selfUser,
			),
		).toBe(true);
	});
});
