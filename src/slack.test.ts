import { describe, expect, test } from "bun:test";

import {
	dockerSafeId,
	mentionedSelf,
	parseSlackPrompt,
	shouldIgnoreSlackEvent,
	slackRuntimeId,
	stripSelfMentions,
} from "./slack.ts";

const selfBot = "BSELF";
const selfUser = "USELF";

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

describe("parseSlackPrompt", () => {
	test("parses @pico grok xhigh prompt", () => {
		const p = parseSlackPrompt(
			`<@${selfUser}> grok xhigh whats the weather`,
			selfUser,
		);
		expect(p.model).toBe("grok");
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("whats the weather");
	});

	test("bare mention leaves empty rest", () => {
		const p = parseSlackPrompt(`<@${selfUser}>`, selfUser);
		expect(p.model).toBeUndefined();
		expect(p.rest).toBe("");
	});

	test("mention plus question keeps the question", () => {
		const p = parseSlackPrompt(`<@${selfUser}> whats the weather?`, selfUser);
		expect(p.model).toBeUndefined();
		expect(p.effort).toBeUndefined();
		expect(p.rest).toBe("whats the weather?");
	});

	test("does not treat ordinary words as a model", () => {
		const p = parseSlackPrompt(`<@${selfUser}> high five everyone`, selfUser);
		expect(p.model).toBeUndefined();
		expect(p.effort).toBeUndefined();
		expect(p.rest).toBe("high five everyone");
	});

	test("accepts xhigh without a model alias", () => {
		const p = parseSlackPrompt(
			`<@${selfUser}> xhigh whats the weather`,
			selfUser,
		);
		expect(p.model).toBeUndefined();
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("whats the weather");
	});

	test("leading-space /new is a new-container command", () => {
		const p = parseSlackPrompt(" /new grok xhigh");
		expect(p.command).toBe("new");
		expect(p.model).toBe("grok");
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("");
	});

	test("/switch keeps rest empty and selects model", () => {
		const p = parseSlackPrompt(" /switch grok xhigh");
		expect(p.command).toBe("switch");
		expect(p.model).toBe("grok");
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("");
	});

	test("still accepts leftover /new prefix", () => {
		const p = parseSlackPrompt("/new grok xhigh\nJOB 1 | OWNER: hakon");
		expect(p.command).toBe("new");
		expect(p.model).toBe("grok");
		expect(p.effort).toBe("xhigh");
		expect(p.rest).toBe("JOB 1 | OWNER: hakon");
	});

	test("leaves ordinary text alone", () => {
		const p = parseSlackPrompt("hello pico");
		expect(p.model).toBeUndefined();
		expect(p.rest).toBe("hello pico");
	});
});

describe("stripSelfMentions", () => {
	test("removes self mention tokens", () => {
		expect(stripSelfMentions(`<@${selfUser}> hi`, selfUser)).toBe("hi");
		expect(mentionedSelf(`<@${selfUser}> hi`, selfUser)).toBe(true);
		expect(mentionedSelf("hi", selfUser)).toBe(false);
	});
});

describe("shouldIgnoreSlackEvent", () => {
	test("drops our own bot echoes", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					bot_id: selfBot,
					text: "hi",
					channel: "C1",
					ts: "1",
				},
				selfBot,
				selfUser,
			),
		).toBe(true);
	});

	test("ignores channel chatter that does not tag pico", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					user: "U0HAKON",
					text: "hi",
					channel: "C1",
					ts: "1",
				},
				selfBot,
				selfUser,
			),
		).toBe(true);
	});

	test("keeps a channel mention", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					user: "U0HAKON",
					text: `<@${selfUser}> hi`,
					channel: "C1",
					ts: "1",
				},
				selfBot,
				selfUser,
			),
		).toBe(false);
	});

	test("keeps app_mention events", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "app_mention",
					user: "U0HAKON",
					text: `<@${selfUser}> hi`,
					channel: "C1",
					ts: "1",
				},
				selfBot,
				selfUser,
			),
		).toBe(false);
	});

	test("keeps thread replies without a re-tag", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					user: "U0HAKON",
					text: "hei",
					channel: "C1",
					ts: "1.1",
					thread_ts: "1.0",
				},
				selfBot,
				selfUser,
			),
		).toBe(false);
	});

	test("keeps DMs without a mention", () => {
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					user: "U0HAKON",
					text: "hi",
					channel: "D1",
					ts: "1",
				},
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
					text: `<@${selfUser}> hi`,
					channel: "C1",
					ts: "1",
				},
				selfBot,
				selfUser,
			),
		).toBe(false);
		expect(
			shouldIgnoreSlackEvent(
				{
					type: "message",
					subtype: "message_changed",
					text: "hi",
					channel: "C1",
					ts: "1",
				},
				selfBot,
				selfUser,
			),
		).toBe(true);
	});
});
