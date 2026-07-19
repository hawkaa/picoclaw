import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	appendJsonl,
	classifyLimitError,
	failureSnapshot,
	formatLimitEvent,
	type LimitEvent,
	normalizeUsage,
	type RawUsageResponse,
	type UsageSnapshot,
	usageEndpoint,
	writeJsonFile,
} from "./usage-probe.ts";

/**
 * Smoke tests for the usage probe. They pin the two things a session depends
 * on: (1) a raw /api/oauth/usage body normalizes into a valid snapshot, and
 * (2) a synthetic limit error appends a parseable JSONL line.
 */

describe("normalizeUsage", () => {
	test("endpoint shape (utilization 0..1, resets_at unix seconds)", () => {
		const resetsSec = 1_800_000_000; // future unix seconds
		const raw: RawUsageResponse = {
			five_hour: { utilization: 0.423, resets_at: resetsSec },
			seven_day: { utilization: 0.15, resets_at: resetsSec + 3600 },
		};
		const snap = normalizeUsage(raw, new Date("2026-07-19T19:30:00.000Z"));
		expect(snap.ok).toBe(true);
		expect(snap.five_hour_utilization_pct).toBe(42.3);
		expect(snap.weekly_utilization_pct).toBe(15);
		expect(snap.resets_at).toBe(new Date(resetsSec * 1000).toISOString());
		expect(snap.weekly_resets_at).toBe(
			new Date((resetsSec + 3600) * 1000).toISOString(),
		);
		expect(snap.probed_at).toBe("2026-07-19T19:30:00.000Z");
		expect(snap.error).toBeNull();
	});

	test("alternate shape (used_percentage 0..100, ISO resets_at)", () => {
		const raw: RawUsageResponse = {
			five_hour: {
				used_percentage: 88,
				resets_at: "2026-07-19T21:00:00.000Z",
			},
			seven_day: { used_percentage: 30 },
		};
		const snap = normalizeUsage(raw);
		expect(snap.five_hour_utilization_pct).toBe(88);
		expect(snap.weekly_utilization_pct).toBe(30);
		expect(snap.resets_at).toBe("2026-07-19T21:00:00.000Z");
		expect(snap.weekly_resets_at).toBeNull();
	});

	test("missing windows produce null, not zero", () => {
		const snap = normalizeUsage({});
		expect(snap.five_hour_utilization_pct).toBeNull();
		expect(snap.weekly_utilization_pct).toBeNull();
		expect(snap.ok).toBe(true);
	});

	test("snapshot round-trips through JSON", () => {
		const snap = normalizeUsage({ five_hour: { utilization: 0.5 } });
		const parsed = JSON.parse(JSON.stringify(snap)) as UsageSnapshot;
		expect(parsed.five_hour_utilization_pct).toBe(50);
	});
});

describe("failureSnapshot", () => {
	test("leaves pct null and carries the error (never looks like 0% used)", () => {
		const snap = failureSnapshot("token expired");
		expect(snap.ok).toBe(false);
		expect(snap.five_hour_utilization_pct).toBeNull();
		expect(snap.weekly_utilization_pct).toBeNull();
		expect(snap.error).toBe("token expired");
	});
});

describe("classifyLimitError", () => {
	test("subscription usage exhaustion", () => {
		expect(
			classifyLimitError("Claude usage limit reached. Resets at 3pm."),
		).toBe("usage_limit_reached");
		expect(classifyLimitError("You have exceeded your monthly usage")).toBe(
			"usage_limit_reached",
		);
	});

	test("rate limiting", () => {
		expect(classifyLimitError("rate_limit_error: slow down")).toBe(
			"rate_limit",
		);
		expect(classifyLimitError("HTTP 429 Too Many Requests")).toBe("rate_limit");
	});

	test("benign text is not a limit", () => {
		expect(classifyLimitError("Container exited with code 1")).toBeNull();
		expect(classifyLimitError("wrote 429 bytes to disk")).toBeNull();
		expect(classifyLimitError("session completed successfully")).toBeNull();
	});
});

describe("usageEndpoint", () => {
	const saved = process.env["ANTHROPIC_BASE_URL"];
	afterEach(() => {
		if (saved === undefined) delete process.env["ANTHROPIC_BASE_URL"];
		else process.env["ANTHROPIC_BASE_URL"] = saved;
	});

	test("defaults to the first-party API host", () => {
		delete process.env["ANTHROPIC_BASE_URL"];
		expect(usageEndpoint()).toBe("https://api.anthropic.com/api/oauth/usage");
	});

	test("honors ANTHROPIC_BASE_URL and trims trailing slash", () => {
		process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example.test/";
		expect(usageEndpoint()).toBe("https://proxy.example.test/api/oauth/usage");
	});
});

describe("limit-event jsonl io", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-probe-test-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("formatLimitEvent + appendJsonl writes a parseable line", () => {
		const ev = formatLimitEvent({
			chatId: "12345",
			errorClass: "usage_limit_reached",
			label: "task-worker-opus",
			detail: "Claude usage limit reached",
			ts: new Date("2026-07-19T20:00:00.000Z"),
		});
		const file = path.join(dir, "sub", "limit-events.jsonl");
		appendJsonl(file, ev);
		appendJsonl(file, ev);

		const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const parsed = JSON.parse(lines[0] as string) as LimitEvent;
		expect(parsed.chatId).toBe("12345");
		expect(parsed.error_class).toBe("usage_limit_reached");
		expect(parsed.label).toBe("task-worker-opus");
		expect(parsed.ts).toBe("2026-07-19T20:00:00.000Z");
	});

	test("writeJsonFile writes valid JSON atomically", () => {
		const snap = normalizeUsage({ five_hour: { utilization: 0.9 } });
		const file = path.join(dir, "usage-status.json");
		writeJsonFile(file, snap);
		const readback = JSON.parse(
			fs.readFileSync(file, "utf-8"),
		) as UsageSnapshot;
		expect(readback.five_hour_utilization_pct).toBe(90);
		expect(readback.ok).toBe(true);
		// No stray temp file left behind by the temp-then-rename write.
		expect(fs.readdirSync(dir)).toEqual(["usage-status.json"]);
	});
});
