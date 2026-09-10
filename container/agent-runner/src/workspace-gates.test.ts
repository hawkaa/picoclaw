import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	buildPayload,
	createWorkspaceGatesExtension,
	GATES,
	type GateSpec,
	hookToolName,
	interpretGateOutput,
	parseAdditionalContext,
	runGates,
	simulateEdits,
} from "./workspace-gates.ts";

const WORKSPACE = "/workspace";
const gate = (id: string): GateSpec => {
	const g = GATES.find((x) => x.id === id);
	if (!g) throw new Error(`no gate ${id}`);
	return g;
};

/** The real guards only exist inside the container. CI runs the hermetic half. */
const haveWorkspace = GATES.every((g) =>
	fs.existsSync(path.join(WORKSPACE, g.script)),
);

// ── Hermetic: the bridge's own logic ────────────────────────────────────────

describe("tool-name mapping", () => {
	test("maps the three gated tools and ignores read-only ones", () => {
		expect(hookToolName("write")).toBe("Write");
		expect(hookToolName("edit")).toBe("Edit");
		expect(hookToolName("bash")).toBe("Bash");
		for (const t of ["read", "grep", "find", "ls", "Write"]) {
			expect(hookToolName(t)).toBeNull();
		}
	});
});

describe("simulateEdits", () => {
	test("applies every block in order, once each", () => {
		expect(simulateEdits("a b a", [{ oldText: "a", newText: "X" }])).toBe(
			"X b a",
		);
		expect(
			simulateEdits("one two", [
				{ oldText: "one", newText: "1" },
				{ oldText: "two", newText: "2" },
			]),
		).toBe("1 2");
	});

	test("returns null when a block does not match (caller fails open)", () => {
		expect(simulateEdits("abc", [{ oldText: "zzz", newText: "q" }])).toBeNull();
		expect(simulateEdits("abc", [])).toBeNull();
		expect(simulateEdits("abc", [{ oldText: "", newText: "q" }])).toBeNull();
	});

	test("does not interpret $-patterns in replacement text", () => {
		// String.replace would turn "$&" into the matched text and silently
		// change the size this content is measured at.
		const out = simulateEdits("HOLE", [
			{ oldText: "HOLE", newText: "$& $' $`" },
		]);
		expect(out).toBe("$& $' $`");
	});
});

describe("buildPayload", () => {
	const read = (p: string) => (p === "/f.md" ? "AAA-BBB" : null);

	test("write → Write with file_path/content", () => {
		expect(
			buildPayload(
				gate("probe-first-guard"),
				"Write",
				{ path: "/f.md", content: "hi" },
				read,
			),
		).toEqual({
			tool_name: "Write",
			tool_input: { file_path: "/f.md", content: "hi" },
		});
	});

	test("edit → Edit carrying every introduced block as new text", () => {
		const p = buildPayload(
			gate("probe-first-guard"),
			"Edit",
			{
				path: "/f.md",
				edits: [
					{ oldText: "AAA", newText: "first" },
					{ oldText: "BBB", newText: "second" },
				],
			},
			read,
		);
		expect(p?.tool_name).toBe("Edit");
		expect(p?.tool_input["new_string"]).toBe("first\nsecond");
		expect(p?.tool_input["content"]).toBe("first\nsecond");
		expect(p?.tool_input["old_string"]).toBe("AAA");
	});

	test("post-state gate sees the whole simulated file, not one block", () => {
		const p = buildPayload(
			gate("constitution-budget-guard"),
			"Edit",
			{ path: "/f.md", edits: [{ oldText: "AAA", newText: "XXXX" }] },
			read,
		);
		// A one-block Edit payload would have shown the guard 4 chars; the file
		// will actually be 8. Undercounting is how a budget guard goes false-clean.
		expect(p).toEqual({
			tool_name: "Write",
			tool_input: { file_path: "/f.md", content: "XXXX-BBB" },
		});
	});

	test("post-state gate stands down when the file cannot be simulated", () => {
		expect(
			buildPayload(
				gate("constitution-budget-guard"),
				"Edit",
				{ path: "/missing.md", edits: [{ oldText: "a", newText: "b" }] },
				read,
			),
		).toBeNull();
	});

	test("bash reaches only the gate that asked for Bash", () => {
		const cmd = { command: "echo hi > /ipc/messages/x.md" };
		expect(
			buildPayload(gate("ipc-duplicate-guard"), "Bash", cmd, read),
		).toEqual({ tool_name: "Bash", tool_input: { command: cmd.command } });
		expect(
			buildPayload(gate("probe-first-guard"), "Bash", cmd, read),
		).toBeNull();
	});
});

describe("interpretGateOutput", () => {
	test("exit 2 blocks with the stderr reason", () => {
		const v = interpretGateOutput(2, "", "over budget by 400 chars");
		expect(v.block).toBe(true);
		expect(v.reason).toBe("over budget by 400 chars");
	});

	test("permissionDecision deny blocks", () => {
		const v = interpretGateOutput(
			0,
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: "dead-rail",
				},
			}),
			"",
		);
		expect(v).toEqual({ block: true, reason: "dead-rail" });
	});

	test("clean exit, non-JSON output and crashes all allow", () => {
		expect(interpretGateOutput(0, "", "").block).toBe(false);
		expect(interpretGateOutput(0, "not json", "").block).toBe(false);
		expect(interpretGateOutput(1, "", "boom").block).toBe(false);
		expect(interpretGateOutput(null, "", "timeout").block).toBe(false);
	});

	test("stderr on a clean exit surfaces as a warning, not a block", () => {
		const v = interpretGateOutput(0, "", "FLOOR: corpus unreadable");
		expect(v.block).toBe(false);
		expect(v.warning).toBe("FLOOR: corpus unreadable");
	});
});

describe("runGates fail-open contract", () => {
	// pi turns a thrown error in beforeToolCall into a hard block, so a broken
	// guard must never propagate.
	const exploding: GateSpec = {
		id: "boom",
		script: "tools/pico-db/probe-first-guard.ts",
		tools: ["Write"],
		payload: "as-called",
		timeoutMs: 100,
	};

	test("a throwing guard allows the call", () => {
		const res = runGates(
			"write",
			{ path: "/tmp/x", content: "y" },
			{
				workspace: WORKSPACE,
				gates: [exploding],
				runScript: () => {
					throw new Error("spawn failed");
				},
			},
		);
		expect(res).toBeUndefined();
	});

	test("first deny wins and is attributed to its gate", () => {
		const res = runGates(
			"write",
			{ path: "/tmp/x", content: "y" },
			{
				workspace: WORKSPACE,
				gates: [exploding],
				runScript: () => ({ status: 2, stdout: "", stderr: "nope" }),
			},
		);
		expect(res?.block).toBe(true);
		expect(res?.reason).toBe("boom: nope");
	});

	test("unknown tools are not gated at all", () => {
		let called = false;
		const res = runGates(
			"read",
			{ path: "/workspace/CLAUDE.md" },
			{
				workspace: WORKSPACE,
				gates: GATES,
				runScript: () => {
					called = true;
					return { status: 0, stdout: "", stderr: "" };
				},
			},
		);
		expect(res).toBeUndefined();
		expect(called).toBe(false);
	});
});

describe("parseAdditionalContext", () => {
	test("extracts injected context, ignores everything else", () => {
		expect(
			parseAdditionalContext(
				JSON.stringify({
					hookSpecificOutput: { additionalContext: " goals: ship \n" },
				}),
			),
		).toBe("goals: ship");
		expect(parseAdditionalContext(null)).toBeNull();
		expect(parseAdditionalContext("")).toBeNull();
		expect(parseAdditionalContext("plain text")).toBeNull();
		expect(
			parseAdditionalContext(
				JSON.stringify({ hookSpecificOutput: { additionalContext: "   " } }),
			),
		).toBeNull();
	});
});

// ── Integration: the REAL guard scripts, through the REAL subprocess path ───
// A bridge that only ever runs against a fake guard tests a fantasy: the whole
// risk here is field names and tool names the guards no-op on.

const itReal = haveWorkspace ? test : test.skip;

function verdict(
	toolName: string,
	input: Record<string, unknown>,
	only?: string,
) {
	return runGates(toolName, input, {
		workspace: WORKSPACE,
		...(only ? { gates: [gate(only)] } : {}),
	});
}

describe("real guards (container only)", () => {
	itReal("probe-first-guard blocks a dead-rail IPC write", () => {
		const res = verdict("write", {
			path: "/ipc/messages/bridge-selftest.md",
			content: "Test note",
		});
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("dead-rail");
	});

	itReal("probe-first-guard blocks a deferral claim with no probe", () => {
		const res = verdict(
			"write",
			{
				path: "/ipc/messages/bridge-selftest.json",
				content:
					"Denne krever din browser — I cannot autonomously submit this.",
			},
			"probe-first-guard",
		);
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("probe-first-guard");
	});

	itReal("probe-first-guard lets a clean IPC write through", () => {
		expect(
			verdict(
				"write",
				{
					path: "/ipc/messages/bridge-selftest.json",
					content: "Status: shipped the thing.",
				},
				"probe-first-guard",
			),
		).toBeUndefined();
	});

	itReal("preedit-gate blocks an ungated AgentLair worker edit", () => {
		const res = verdict(
			"write",
			{
				path: "/workspace/agentlair/packages/worker/src/bridge-selftest.ts",
				content: "export const x = 1;",
			},
			"agentlair-preedit-gate",
		);
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("preedit-gate");
	});

	itReal("preedit-gate ignores files outside the worker source root", () => {
		expect(
			verdict(
				"write",
				{ path: "/workspace/tmp/bridge-selftest.ts", content: "x" },
				"agentlair-preedit-gate",
			),
		).toBeUndefined();
	});

	itReal(
		"budget guard blocks an edit that pushes CLAUDE.md over budget",
		() => {
			const res = verdict(
				"edit",
				{
					path: "/workspace/CLAUDE.md",
					edits: [{ oldText: "# User", newText: `# User${"x".repeat(5000)}` }],
				},
				"constitution-budget-guard",
			);
			expect(res?.block).toBe(true);
			expect(res?.reason).toContain("budget");
		},
	);

	itReal("budget guard allows an edit that stays within budget", () => {
		expect(
			verdict(
				"edit",
				{
					path: "/workspace/CLAUDE.md",
					edits: [{ oldText: "# User", newText: "# User" }],
				},
				"constitution-budget-guard",
			),
		).toBeUndefined();
	});

	itReal(
		"generated-file guard blocks a write to a do-not-edit artifact",
		() => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-"));
			const f = path.join(dir, "worker.ts");
			fs.writeFileSync(
				f,
				"// Auto-generated Cloudflare Worker — do not edit by hand\n// Built from build.ts\nexport const a = 1;\n",
			);
			try {
				const res = verdict(
					"write",
					{ path: f, content: "export const a = 2;\n" },
					"generated-file-edit-guard",
				);
				expect(res?.block).toBe(true);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	itReal("generated-file guard allows a hand-written file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-"));
		const f = path.join(dir, "notes.ts");
		fs.writeFileSync(f, "export const a = 1;\n");
		try {
			expect(
				verdict(
					"write",
					{ path: f, content: "export const a = 2;\n" },
					"generated-file-edit-guard",
				),
			).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// The duplicate-detection arm depends on a live 7-day corpus and would rot
	// here; it is the guard's own test. What these two pin is the RAIL — a Bash
	// heredoc into /ipc/messages was the rail 42 of 106 measured IPC writes used,
	// and no other gate watches it.
	itReal(
		"ipc-duplicate-guard blocks a dead-rail heredoc on the Bash rail",
		() => {
			const res = verdict(
				"bash",
				{
					command: `cat > /ipc/messages/bridge-selftest-${Date.now()}.md <<'EOF'\nEmail fra Bridge Selftest <selftest@example.invalid>: Subject ${Date.now()}\nEOF`,
				},
				"ipc-duplicate-guard",
			);
			expect(res?.block).toBe(true);
			expect(res?.reason).toContain("dead-rail");
		},
	);

	itReal(
		"the registered pi handler blocks a real tool_call event",
		async () => {
			// Everything up to pi's own dispatcher: factory → pi.on("tool_call") →
			// handler → guard subprocess → { block }. pi's side is proven by the
			// engine itself (emitToolCall returns the first result whose .block is
			// true, and beforeToolCall is installed unconditionally).
			let handler: ((e: ToolCallEvent, ctx: unknown) => unknown) | undefined;
			const pi = {
				on: (event: string, h: (e: ToolCallEvent, ctx: unknown) => unknown) => {
					if (event === "tool_call") handler = h;
				},
			} as unknown as ExtensionAPI;

			createWorkspaceGatesExtension(WORKSPACE, () => {})(pi);
			expect(handler).toBeDefined();

			const blocked = (await handler?.(
				{
					type: "tool_call",
					toolCallId: "call-1",
					toolName: "write",
					input: {
						path: "/ipc/messages/bridge-selftest.md",
						content: "note",
					},
				} as ToolCallEvent,
				{},
			)) as ToolCallEventResult | undefined;
			expect(blocked?.block).toBe(true);

			const allowed = await handler?.(
				{
					type: "tool_call",
					toolCallId: "call-2",
					toolName: "read",
					input: { path: "/workspace/CLAUDE.md" },
				} as ToolCallEvent,
				{},
			);
			expect(allowed).toBeUndefined();
		},
	);

	itReal(
		"ipc-duplicate-guard allows a fresh note on the delivered rail",
		() => {
			const res = verdict(
				"bash",
				{
					command: `cat > /ipc/messages/bridge-selftest-${Date.now()}.json <<'EOF'\nEmail fra Bridge Selftest <selftest@example.invalid>: Subject ${Date.now()}\nEOF`,
				},
				"ipc-duplicate-guard",
			);
			expect(res).toBeUndefined();
		},
	);
});
