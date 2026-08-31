#!/usr/bin/env bun
/**
 * PicoClaw container smoke-test — validates deployment health after container
 * image rebuilds.
 *
 * Runs standalone with `bun container/seeds/picoclaw-smoketest.ts` from the
 * project root, or inside the container at any path.
 *
 * Checks:
 *   1. Claude CLI version ≥ 2.1.126
 *   2. /workspace is writable
 *   3. /ipc directory exists and is writable
 *   4. AGENTLAIR_AAT env var is present (if agentlair is enabled)
 *   5. Key tools available: bun --version and basic bun script execution
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIN_CLAUDE_VERSION = [2, 1, 126] as const;

interface CheckResult {
	name: string;
	passed: boolean;
	detail: string;
}

const results: CheckResult[] = [];

function check(name: string, fn: () => string): void {
	try {
		const detail = fn();
		results.push({ name, passed: true, detail });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		results.push({ name, passed: false, detail });
	}
}

// ── 1. Claude CLI version ────────────────────────────────────────────────────
check("Claude CLI version", () => {
	let raw: string;
	try {
		raw = execSync("claude --version", { encoding: "utf8" }).trim();
	} catch {
		throw new Error("claude CLI not found or failed to execute");
	}

	// Expected format: "2.1.126 (Claude Code)"
	const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error(`Unexpected version format: ${raw}`);
	}

	const [, maj, min, patch] = match.map(Number) as [
		number,
		number,
		number,
		number,
	];
	const [expMaj, expMin, expPatch] = MIN_CLAUDE_VERSION;

	const tooOld =
		maj < expMaj ||
		(maj === expMaj && min < expMin) ||
		(maj === expMaj && min === expMin && patch < expPatch);

	if (tooOld) {
		throw new Error(
			`Version ${maj}.${min}.${patch} is below minimum ${expMaj}.${expMin}.${expPatch}`,
		);
	}

	return raw;
});

// ── 2. /workspace is writable ────────────────────────────────────────────────
check("/workspace writable", () => {
	const probe = join("/workspace", `.smoketest-probe-${Date.now()}`);
	writeFileSync(probe, "ok");
	rmSync(probe);
	return "/workspace write+delete OK";
});

// ── 3. /ipc exists and is writable ──────────────────────────────────────────
check("/ipc writable", () => {
	// /ipc/messages must exist; /ipc itself may not be writable to non-root,
	// but the subdirectories should be.
	const messagesDir = "/ipc/messages";
	const probe = join(messagesDir, `.smoketest-probe-${Date.now()}`);
	try {
		writeFileSync(probe, "ok");
		rmSync(probe);
	} catch {
		// Directory may not exist yet in dev environments — try creating it.
		mkdirSync(messagesDir, { recursive: true });
		writeFileSync(probe, "ok");
		rmSync(probe);
	}
	return "/ipc/messages write+delete OK";
});

// ── 4. AGENTLAIR_AAT env var ─────────────────────────────────────────────────
check("AGENTLAIR_AAT present", () => {
	const token = process.env["AGENTLAIR_AAT"];
	if (!token) {
		// Not a hard failure — agentlair may be disabled for this bot.
		// We warn rather than throw.
		return "AGENTLAIR_AAT not set (agentlair may be disabled — OK if intentional)";
	}
	// Minimal shape check: a JWT has three dot-separated parts.
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error(
			`AGENTLAIR_AAT present but malformed (expected 3 JWT segments, got ${parts.length})`,
		);
	}
	const payloadJson = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
	const payload = JSON.parse(payloadJson) as Record<string, unknown>;
	const exp = payload["exp"];
	if (typeof exp === "number" && exp < Date.now() / 1000) {
		throw new Error(`AGENTLAIR_AAT is expired (exp=${exp})`);
	}
	return `AGENTLAIR_AAT present — sub=${payload["sub"] ?? "unknown"}`;
});

// ── 5. Bun available and functional ─────────────────────────────────────────
check("bun --version", () => {
	const ver = execSync("bun --version", { encoding: "utf8" }).trim();
	return `bun ${ver}`;
});

check("bun script execution", () => {
	const result = execSync(`bun -e "console.log('ok')"`, {
		encoding: "utf8",
	}).trim();
	if (result !== "ok") {
		throw new Error(`Expected 'ok', got: ${result}`);
	}
	return "bun inline script OK";
});

// ── Report ────────────────────────────────────────────────────────────────────
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";

console.log("\nPicoClaw container smoke-test\n");

let anyFailed = false;

for (const r of results) {
	const icon = r.passed ? PASS : FAIL;
	if (!r.passed) anyFailed = true;

	// Treat "not set (agentlair may be disabled)" as a warning, not failure.
	const isWarning =
		r.passed && r.detail.includes("not set (agentlair may be disabled");
	const displayIcon = isWarning ? WARN : icon;

	console.log(`  ${displayIcon} ${r.name}`);
	if (!r.passed || isWarning) {
		console.log(`      ${r.detail}`);
	} else {
		console.log(`      ${r.detail}`);
	}
}

const total = results.length;
const passed = results.filter((r) => r.passed).length;
const failed = total - passed;

console.log(
	`\n${passed}/${total} checks passed${failed > 0 ? `, ${failed} FAILED` : ""}\n`,
);

process.exit(anyFailed ? 1 : 0);
