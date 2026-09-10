/**
 * workspace-gates.ts — runs the workspace's PreToolUse guards under pi.
 *
 * WHY THIS FILE EXISTS
 * The workspace (/workspace/.claude/settings.json) carries a set of guard
 * scripts that Claude Code used to run as PreToolUse hooks. PR #42 swapped the
 * in-container engine from Claude Code to pi, and pi does not read that file:
 * measured 2026-09-10, 38 pi sessions ran with 0 hook executions. Five guards
 * went silently dead — among them the one that blocks writes to a dead IPC rail
 * (a message the host never delivers) and the one that caps the size of the
 * files every session pays for in context.
 *
 * pi's own extension API is a superset of what those hooks needed:
 *   - `tool_call` fires before a tool executes and can return { block, reason }.
 * So the bridge is an adapter, not a reimplementation: the guard scripts stay
 * where they are, keep their own tests, and keep the Claude Code hook contract
 * (event JSON on stdin, deny via stdout JSON or exit 2). This file translates
 * pi's event shape into that contract and translates the verdict back.
 *
 * FAIL-OPEN IS A HARD REQUIREMENT. pi wraps `beforeToolCall` so that a THROWN
 * error blocks execution ("Extension failed, blocking execution"). A guard that
 * crashes must never wedge the agent, so every path here is caught and the
 * default verdict is allow. Each guard script already documents the same rule.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** Claude Code hook matcher names — the vocabulary the guard scripts speak. */
export type HookTool = "Write" | "Edit" | "Bash";

export interface GateSpec {
	id: string;
	/** Path relative to the workspace root. */
	script: string;
	/** Which tool calls this gate wants to see (its settings.json matcher). */
	tools: HookTool[];
	/**
	 * "as-called"  — faithful translation of the tool call.
	 * "post-state" — always presented as a Write carrying the file's simulated
	 *                final content. Used by the budget guard, which only cares
	 *                about the resulting size: pi's `edit` applies N blocks in
	 *                one call, and a one-block Edit payload would undercount a
	 *                multi-block edit by construction.
	 */
	payload: "as-called" | "post-state";
	timeoutMs: number;
}

/** Mirror of the PreToolUse block in /workspace/.claude/settings.json. */
export const GATES: GateSpec[] = [
	{
		id: "probe-first-guard",
		script: "tools/pico-db/probe-first-guard.ts",
		tools: ["Write", "Edit"],
		payload: "as-called",
		timeoutMs: 5000,
	},
	{
		id: "agentlair-preedit-gate",
		script: "tools/agentlair-pipeline/preedit-gate.ts",
		tools: ["Write", "Edit"],
		payload: "as-called",
		timeoutMs: 5000,
	},
	{
		id: "generated-file-edit-guard",
		script: "tools/pico-db/generated-file-edit-guard.ts",
		tools: ["Write", "Edit"],
		payload: "as-called",
		timeoutMs: 5000,
	},
	{
		id: "constitution-budget-guard",
		script: "tools/pico-db/constitution-budget-guard.ts",
		tools: ["Write", "Edit"],
		payload: "post-state",
		timeoutMs: 5000,
	},
	{
		id: "ipc-duplicate-guard",
		script: "tools/pico-db/ipc-duplicate-guard.ts",
		tools: ["Write", "Bash"],
		payload: "as-called",
		timeoutMs: 5000,
	},
];

export interface HookPayload {
	tool_name: HookTool;
	tool_input: Record<string, unknown>;
}

export interface GateVerdict {
	block: boolean;
	reason?: string;
	/** Non-blocking stderr from the guard, surfaced in the runner log. */
	warning?: string;
}

interface EditBlock {
	oldText: string;
	newText: string;
}

/** pi tool name → Claude Code matcher name. Unknown/read-only tools → null. */
export function hookToolName(toolName: string): HookTool | null {
	switch (toolName) {
		case "write":
			return "Write";
		case "edit":
			return "Edit";
		case "bash":
			return "Bash";
		default:
			return null;
	}
}

function targetPath(input: Record<string, unknown>): string {
	const p = input["path"] ?? input["file_path"];
	return typeof p === "string" ? p : "";
}

function editBlocks(input: Record<string, unknown>): EditBlock[] {
	const raw = input["edits"];
	if (Array.isArray(raw)) {
		const blocks: EditBlock[] = [];
		for (const e of raw) {
			if (!e || typeof e !== "object") continue;
			const rec = e as Record<string, unknown>;
			const oldText = rec["oldText"];
			const newText = rec["newText"];
			if (typeof oldText === "string" && typeof newText === "string") {
				blocks.push({ oldText, newText });
			}
		}
		return blocks;
	}
	// Defensive: a single-block form, should pi ever expose one.
	const oldText = input["oldText"];
	const newText = input["newText"];
	if (typeof oldText === "string" && typeof newText === "string") {
		return [{ oldText, newText }];
	}
	return [];
}

/**
 * Apply pi's edit semantics (each oldText replaced once) to `before`.
 * Returns null when a block does not match exactly — pi also does fuzzy and
 * CRLF-normalised matching, so a miss here means "cannot simulate", not
 * "the edit will fail". Callers must fail OPEN on null.
 *
 * Uses indexOf/slice rather than String.replace: `replace` with a string
 * pattern still interprets `$&`, "$'" and `` $` `` inside the replacement,
 * which would corrupt any content-derived size measurement.
 */
export function simulateEdits(
	before: string,
	edits: EditBlock[],
): string | null {
	if (edits.length === 0) return null;
	let out = before;
	for (const { oldText, newText } of edits) {
		if (oldText.length === 0) return null;
		const i = out.indexOf(oldText);
		if (i < 0) return null;
		out = out.slice(0, i) + newText + out.slice(i + oldText.length);
	}
	return out;
}

/**
 * Translate one pi tool call into the Claude Code PreToolUse payload the guard
 * expects. Returns null when this gate should not see this call at all.
 */
export function buildPayload(
	gate: GateSpec,
	tool: HookTool,
	input: Record<string, unknown>,
	readFile: (p: string) => string | null,
): HookPayload | null {
	if (!gate.tools.includes(tool)) return null;

	if (tool === "Bash") {
		const command = input["command"];
		if (typeof command !== "string" || command.length === 0) return null;
		return { tool_name: "Bash", tool_input: { command } };
	}

	const file_path = targetPath(input);
	if (!file_path) return null;

	if (tool === "Write") {
		const content =
			typeof input["content"] === "string" ? input["content"] : "";
		return { tool_name: "Write", tool_input: { file_path, content } };
	}

	// tool === "Edit"
	const blocks = editBlocks(input);
	if (blocks.length === 0) return null;

	if (gate.payload === "post-state") {
		const before = readFile(file_path);
		if (before === null) return null; // new file or unreadable → nothing to size
		const after = simulateEdits(before, blocks);
		if (after === null) return null; // cannot simulate → fail open
		// Deliberately presented as a Write: the guard's question is "what will
		// this file BE", and a Write payload answers it exactly, for any number
		// of blocks.
		return { tool_name: "Write", tool_input: { file_path, content: after } };
	}

	const newText = blocks.map((b) => b.newText).join("\n");
	return {
		tool_name: "Edit",
		tool_input: {
			file_path,
			old_string: blocks[0]?.oldText ?? "",
			new_string: newText,
			// Guards that scan "the text being introduced" read content first.
			content: newText,
		},
	};
}

/**
 * Interpret a guard's process result using the Claude Code hook contract:
 *   exit 2                                   → block, reason from stderr
 *   exit 0 + {hookSpecificOutput:{permissionDecision:"deny", ...}} → block
 *   anything else                            → allow (fail open)
 */
export function interpretGateOutput(
	status: number | null,
	stdout: string,
	stderr: string,
): GateVerdict {
	if (status === 2) {
		return { block: true, reason: stderr.trim() || "blocked (exit 2)" };
	}
	const text = stdout.trim();
	if (text.startsWith("{")) {
		try {
			const parsed = JSON.parse(text) as {
				hookSpecificOutput?: {
					permissionDecision?: string;
					permissionDecisionReason?: string;
				};
			};
			const out = parsed.hookSpecificOutput;
			if (out?.permissionDecision === "deny") {
				return {
					block: true,
					reason: out.permissionDecisionReason?.trim() || "blocked",
				};
			}
		} catch {
			// Not our JSON — treat as allow.
		}
	}
	const warning = stderr.trim();
	return warning ? { block: false, warning } : { block: false };
}

export interface RunGatesOptions {
	workspace: string;
	gates?: GateSpec[];
	/** Injected for tests; defaults to a real `bun <script>` subprocess. */
	runScript?: (
		scriptPath: string,
		payload: HookPayload,
		timeoutMs: number,
	) => { status: number | null; stdout: string; stderr: string };
	readFile?: (p: string) => string | null;
	log?: (message: string) => void;
}

/**
 * Only "post-state" gates read the target file, and only to size it. Cap the
 * read so an edit to a large artifact never pays for a full slurp on every
 * call: nothing under a size budget is anywhere near this.
 */
const MAX_SIMULATED_FILE_BYTES = 2 * 1024 * 1024;

function defaultReadFile(p: string): string | null {
	try {
		if (fs.statSync(p).size > MAX_SIMULATED_FILE_BYTES) return null;
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

function defaultRunScript(
	scriptPath: string,
	payload: HookPayload,
	timeoutMs: number,
): { status: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [scriptPath], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
	});
	return {
		status: res.status,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

/**
 * Run every gate that matches this tool call. First deny wins, matching the
 * settings.json semantics (and pi's own emitToolCall short-circuit).
 */
export function runGates(
	toolName: string,
	input: Record<string, unknown>,
	opts: RunGatesOptions,
): ToolCallEventResult | undefined {
	const tool = hookToolName(toolName);
	if (!tool) return undefined;

	const gates = opts.gates ?? GATES;
	const readFile = opts.readFile ?? defaultReadFile;
	const runScript = opts.runScript ?? defaultRunScript;
	const log = opts.log ?? (() => {});

	for (const gate of gates) {
		try {
			const payload = buildPayload(gate, tool, input, readFile);
			if (!payload) continue;
			const scriptPath = path.join(opts.workspace, gate.script);
			if (!fs.existsSync(scriptPath)) continue;

			const res = runScript(scriptPath, payload, gate.timeoutMs);
			const verdict = interpretGateOutput(res.status, res.stdout, res.stderr);
			if (verdict.warning) log(`[${gate.id}] ${verdict.warning}`);
			if (verdict.block) {
				log(`[${gate.id}] BLOCKED ${tool} ${targetPath(input) || ""}`);
				return {
					block: true,
					reason: `${gate.id}: ${verdict.reason ?? "blocked"}`,
				};
			}
		} catch (err) {
			// Never block on guard malfunction, and never throw: pi turns a thrown
			// error in beforeToolCall into a hard block.
			log(
				`[${gate.id}] gate error (allowing): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return undefined;
}

/**
 * pi extension: register the workspace guards on `tool_call`.
 */
export function createWorkspaceGatesExtension(
	workspace: string,
	log: (message: string) => void,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on(
			"tool_call",
			(event: ToolCallEvent): ToolCallEventResult | undefined => {
				try {
					return runGates(
						event.toolName,
						(event.input ?? {}) as Record<string, unknown>,
						{ workspace, log },
					);
				} catch (err) {
					log(
						`workspace-gates dispatch error (allowing): ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
					return undefined;
				}
			},
		);
	};
}

/* ── Session-lifecycle bridge ───────────────────────────────────────────────
 * SessionStart/SessionEnd were also settings.json hooks. They need no
 * extension API: the runner owns the session boundary, so main() calls these
 * directly. Same stdin contract as the hooks (event JSON), same fail-open rule.
 */

export function runWorkspaceHook(
	workspace: string,
	script: string,
	args: string[],
	event: Record<string, unknown>,
	timeoutMs = 10_000,
): string | null {
	try {
		const scriptPath = path.join(workspace, script);
		if (!fs.existsSync(scriptPath)) return null;
		const res = spawnSync(process.execPath, [scriptPath, ...args], {
			input: JSON.stringify(event),
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		return res.stdout ?? null;
	} catch {
		return null;
	}
}

/**
 * Extract the injected context from a SessionStart hook's JSON output.
 * Returns null when there is nothing to inject.
 */
export function parseAdditionalContext(stdout: string | null): string | null {
	if (!stdout) return null;
	const text = stdout.trim();
	if (!text.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(text) as {
			hookSpecificOutput?: { additionalContext?: string };
		};
		const ctx = parsed.hookSpecificOutput?.additionalContext;
		return typeof ctx === "string" && ctx.trim() ? ctx.trim() : null;
	} catch {
		return null;
	}
}
