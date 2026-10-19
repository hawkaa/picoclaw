import { describe, expect, test } from "bun:test";
import { agentErrorFrom, exitError } from "./container-runner.ts";
import { SpawnHealthMonitor } from "./spawn-health.ts";

const GB = 1024 ** 3;

function setup(opts: { free?: number | null; threshold?: number } = {}) {
	const sent: string[] = [];
	let t = Date.parse("2026-10-04T23:30:00Z");
	let free = opts.free === undefined ? 20 * GB : opts.free;
	const m = new SpawnHealthMonitor({
		notify: async (text) => {
			sent.push(text);
		},
		freeBytes: () => free,
		threshold: opts.threshold ?? 3,
		now: () => t,
	});
	return {
		m,
		sent,
		advance: (ms: number) => {
			t += ms;
		},
		setFree: (b: number | null) => {
			free = b;
		},
	};
}

const fail = { status: "error" as const, error: "ENOSPC: no space left" };
const ok = { status: "success" as const };

describe("SpawnHealthMonitor", () => {
	test("alerts once when the failure streak reaches the threshold", async () => {
		const { m, sent } = setup();
		await m.record(fail);
		await m.record(fail);
		expect(sent).toHaveLength(0);
		await m.record(fail);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("last 3 sessions all failed");
		expect(sent[0]).toContain("since 2026-10-04T23:30Z");
		expect(sent[0]).toContain("ENOSPC");
		for (let i = 0; i < 50; i++) await m.record(fail);
		expect(sent).toHaveLength(1);
	});

	test("a success inside the streak resets it", async () => {
		const { m, sent } = setup();
		await m.record(fail);
		await m.record(fail);
		await m.record(ok);
		await m.record(fail);
		await m.record(fail);
		expect(sent).toHaveLength(0);
	});

	test("sends a recovery line after an alerted streak, then re-arms", async () => {
		const { m, sent, advance } = setup();
		for (let i = 0; i < 3; i++) await m.record(fail);
		advance(10.6 * 3_600_000);
		await m.record(ok);
		expect(sent[1]).toContain("work again after 3 failures (10.6h)");
		await m.record(ok);
		expect(sent).toHaveLength(2);
		for (let i = 0; i < 3; i++) await m.record(fail);
		expect(sent).toHaveLength(3);
	});

	test("no recovery line when no alert went out", async () => {
		const { m, sent } = setup();
		await m.record(fail);
		await m.record(ok);
		expect(sent).toHaveLength(0);
	});

	test("warns once on low disk, re-arms only after real headroom", async () => {
		const { m, sent, setFree } = setup({ free: 2 * GB });
		await m.record(ok);
		await m.record(ok);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("2.0 GB free");
		setFree(4 * GB); // above 3 GB but below 6 GB: still armed-off
		await m.record(ok);
		setFree(1 * GB);
		await m.record(ok);
		expect(sent).toHaveLength(1);
		setFree(10 * GB);
		await m.record(ok);
		setFree(1 * GB);
		await m.record(ok);
		expect(sent).toHaveLength(2);
	});

	test("unknown disk never alerts on disk, still alerts on streak", async () => {
		const { m, sent } = setup({ free: null });
		for (let i = 0; i < 3; i++) await m.record(fail);
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toContain("Free disk");
	});

	test("a throwing notify does not throw out of record", async () => {
		const m = new SpawnHealthMonitor({
			notify: async () => {
				throw new Error("telegram down");
			},
			threshold: 1,
		});
		await expect(m.record(fail)).resolves.toContain("all failed");
	});
});

describe("the alert names the cause, not the echo", () => {
	test("first and last error both printed when they differ", async () => {
		const { m, sent } = setup();
		await m.record({
			status: "error",
			error: "ENOSPC: no space left on device, write",
		});
		await m.record({ status: "error", error: "local synchronization failed" });
		await m.record({
			status: "error",
			error: "local synchronization failed (late)",
		});
		expect(sent[0]).toContain("First error: ENOSPC");
		expect(sent[0]).toContain(
			"Last error: local synchronization failed (late)",
		);
	});

	test("one error printed once when the streak never changes its story", async () => {
		const { m, sent } = setup();
		for (let i = 0; i < 3; i++) await m.record(fail);
		expect(sent[0]).toContain("Error: ENOSPC: no space left.");
		expect(sent[0]).not.toContain("First error");
	});

	test("a new streak forgets the old streak's first error", async () => {
		const { m, sent } = setup();
		await m.record({ status: "error", error: "old cause" });
		await m.record(ok);
		for (let i = 0; i < 3; i++)
			await m.record({ status: "error", error: "new cause" });
		expect(sent[0]).not.toContain("old cause");
	});

	// stderr tails of the 2026-10-04/05 fleet-dark streak, verbatim from the host
	// logs (23:20:37 = first failure, then 10.6h of the credential echo).
	const streak = [
		[
			"[agent-runner] Run done. closedDuringQuery=false error=ENOSPC: no space left on device, write",
			"[agent-runner] Agent error: ENOSPC: no space left on device, write",
		],
		[
			"[agent-runner] Agent error: Credential setRuntimeApiKey committed for anthropic, but local synchronization failed",
		],
		[
			"[agent-runner] Agent error: Credential setRuntimeApiKey committed for anthropic, but local synchronization failed",
		],
		[
			"[agent-runner] Agent error: Credential setRuntimeApiKey committed for anthropic, but local synchronization failed",
		],
		[
			"[agent-runner] Agent error: Credential setRuntimeApiKey committed for anthropic, but local synchronization failed",
		],
	];

	test("replayed 4 Oct streak: the alert shows ENOSPC, not just exit code 1", async () => {
		const { m, sent } = setup({ threshold: 5 });
		for (const lines of streak) {
			let last: string | null = null;
			for (const l of lines) last = agentErrorFrom(l) ?? last;
			await m.record({ status: "error", error: exitError(1, last) });
		}
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(
			"First error: ENOSPC: no space left on device, write (exit 1)",
		);
		expect(sent[0]).toContain("Last error: Credential setRuntimeApiKey");
		expect(sent[0]).not.toContain("Container exited with code");
	});

	test("agentErrorFrom reads both runners and nothing else", () => {
		expect(agentErrorFrom("[agent-runner:durable] Agent error: boom")).toBe(
			"boom",
		);
		expect(
			agentErrorFrom(
				"[agent-runner] Run done. closedDuringQuery=false error=x",
			),
		).toBeNull();
		expect(agentErrorFrom("Agent error: not ours")).toBeNull();
		expect(exitError(137, null)).toBe("Container exited with code 137");
	});
});
