import { describe, expect, test } from "bun:test";

import {
	CUTOFF_NOTICE,
	ROTATE_MARGIN_MS,
	RunTracker,
	routeInbound,
	shouldRotate,
	TIMEOUT_MIDRUN,
	timeoutOutcome,
	withDurable,
} from "./chat-lifecycle.ts";
import type { ContainerOutput } from "./types.ts";

const MIN = 60_000;

/**
 * Output-packet sequences (consecutive duplicates collapsed) of every chat
 * container that hit the 60-min cap 10-05..10-18, read from /logs. Ground
 * truth from the runner's own last line: six end «Run ended, waiting for next
 * IPC message» (idle), two end «Starting run...» (killed mid-answer).
 */
const CAP_KILLS: Record<string, { seq: string[]; midRun: boolean }> = {
	"2026-10-05T09-43-19": {
		seq: ["tool_use", "text", "result", "tool_use", "text", "result"],
		midRun: false,
	},
	"2026-10-05T19-00-31": { seq: ["tool_use", "text", "result"], midRun: false },
	"2026-10-09T05-38-23": { seq: ["tool_use", "text", "result"], midRun: false },
	"2026-10-12T05-30-44": {
		seq: ["tool_use", "text", "result", "tool_use", "text", "result"],
		midRun: false,
	},
	"2026-10-15T21-48-08": {
		seq: [
			"tool_use",
			"text",
			"result",
			"tool_use",
			"text",
			"tool_use",
			"result",
		],
		midRun: false,
	},
	"2026-10-16T09-14-19": {
		seq: ["tool_use", "text", "result", "tool_use"],
		midRun: true,
	},
	"2026-10-18T05-22-41": {
		seq: [
			"tool_use",
			"text",
			"tool_use",
			"text",
			"tool_use",
			"text",
			"tool_use",
			"text",
			"tool_use",
		],
		midRun: true,
	},
	"2026-10-18T08-04-25": { seq: ["tool_use", "text", "result"], midRun: false },
};

function packet(type: string): ContainerOutput {
	return {
		status: "success",
		result: null,
		type: type as ContainerOutput["type"],
	};
}

describe("shouldRotate (fake clock)", () => {
	const deadline = 1_000 * MIN;
	test("rotates with less than the margin left", () => {
		expect(shouldRotate(deadline, deadline - 6 * MIN)).toBe(true);
		expect(shouldRotate(deadline, deadline - ROTATE_MARGIN_MS + 1)).toBe(true);
	});
	test("pipes with the margin or more left", () => {
		expect(shouldRotate(deadline, deadline - ROTATE_MARGIN_MS)).toBe(false);
		expect(shouldRotate(deadline, deadline - 55 * MIN)).toBe(false);
	});
});

describe("routeInbound", () => {
	const deadline = 1_000 * MIN;
	test("no live container → spawn", () => {
		expect(routeInbound(undefined, 0)).toBe("spawn");
	});
	test("10-16: GO arrived 2-6 min before the cap → rotate, not pipe", () => {
		expect(routeInbound({ hardDeadline: deadline }, deadline - 6 * MIN)).toBe(
			"rotate",
		);
		expect(routeInbound({ hardDeadline: deadline }, deadline - 2 * MIN)).toBe(
			"rotate",
		);
	});
	test("fresh container → pipe", () => {
		expect(routeInbound({ hardDeadline: deadline }, deadline - 50 * MIN)).toBe(
			"pipe",
		);
	});
	test("a container already rotating keeps holding messages", () => {
		expect(
			routeInbound(
				{ hardDeadline: deadline, pending: [] },
				deadline - 50 * MIN,
			),
		).toBe("rotate");
	});
});

describe("cap-kill outcome", () => {
	test("idle container at the cap stays success", () => {
		expect(timeoutOutcome(false, "s1")).toEqual({
			status: "success",
			result: null,
			newSessionId: "s1",
		});
	});
	test("open run at the cap is an error, keeps the session for the next container", () => {
		expect(timeoutOutcome(true, "s1")).toEqual({
			status: "error",
			result: null,
			error: TIMEOUT_MIDRUN,
			newSessionId: "s1",
		});
	});
	test("the notice tells him how to continue", () => {
		expect(CUTOFF_NOTICE).toMatch(/60-min/);
		expect(CUTOFF_NOTICE).toMatch(/send any message/i);
	});
});

describe("RunTracker", () => {
	test("open from the first prompt until a result packet", () => {
		const r = new RunTracker();
		expect(r.open).toBe(true);
		r.onOutput(packet("text"));
		expect(r.open).toBe(true);
		r.onOutput(packet("result"));
		expect(r.open).toBe(false);
	});
	test("a piped message opens a run before any output", () => {
		const r = new RunTracker();
		r.onOutput(packet("result"));
		r.noteInput();
		expect(r.open).toBe(true);
	});

	// Replay of the real corpus: 8 of 8 classified as the runner's log says.
	for (const [log, { seq, midRun }] of Object.entries(CAP_KILLS)) {
		test(`replay ${log}: ${midRun ? "mid-run → error" : "idle → success"}`, () => {
			const r = new RunTracker();
			for (const t of seq) r.onOutput(packet(t));
			expect(timeoutOutcome(r.open, "s").status).toBe(
				midRun ? "error" : "success",
			);
		});
	}
});

describe("withDurable (opt-in per chat, default off)", () => {
	test("unset or other chats: profile untouched", () => {
		expect(withDurable("42", undefined, undefined)).toBeUndefined();
		const p = { persona: "operator" };
		expect(withDurable("42", p, "7,8")).toBe(p);
		// a prefix of a listed id is not the id
		expect(withDurable("4", undefined, "42")).toBeUndefined();
	});
	test("listed chat runs durable, keeps its other env", () => {
		expect(withDurable("42", { extraEnv: { A: "1" } }, " 7, 42 ")).toEqual({
			extraEnv: { A: "1", PICOCLAW_RUNNER: "durable" },
		});
	});
});
