import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PRECONDITIONS_DIR } from "./config.ts";
import {
	checkTaskPrecondition,
	evaluatePreconditions,
	normalizePreconditions,
	parsePrecondition,
	runCheck,
} from "./precondition.ts";

// Real executables in a real directory, spawned for real. A precondition that
// is only tested against a mock proves nothing about exit codes, timeouts or
// argv handling — which is the entire contract.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picoclaw-precond-"));

function script(name: string, body: string, mode = 0o755): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode });
	fs.chmodSync(file, mode);
	return file;
}

script("yes", "exit 0");
script("no", "exit 1");
script("no-254", "exit 254");
script("broken", "echo boom >&2; exit 255");
script("slow", "sleep 30");
script("not-executable", "exit 0", 0o644);
script(
	"argv",
	// Exits 0 only if it received exactly these two arguments — i.e. the args
	// arrived as argv, unsplit and uninterpreted.
	'[ "$1" = "--folder=INBOX Mail" ] && [ "$2" = ";touch pwned" ] && exit 0 || exit 1',
);
script(
	"wants-workspace",
	'[ -n "$PICOCLAW_WORKSPACE_DIR" ] && exit 0 || exit 1',
);
script("marker", `touch "${path.join(dir, "ran-marker")}"; exit 1`);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("parsePrecondition", () => {
	test("name plus argv", () => {
		expect(parsePrecondition("imap-work --messages=INBOX")).toEqual({
			name: "imap-work",
			args: ["--messages=INBOX"],
		});
	});

	test("rejects anything that is not a bare check name", () => {
		// Path traversal, absolute paths, shell metacharacters, and the empty
		// string all have to be rejected BEFORE anything is spawned.
		for (const bad of [
			"../../bin/sh",
			"/bin/sh",
			"sub/dir/check",
			";rm -rf /",
			"a&&b",
			"$(id)",
			"",
			"   ",
			".hidden",
		]) {
			expect(parsePrecondition(bad)).toBeNull();
		}
	});
});

describe("normalizePreconditions", () => {
	test("string, array, empty and blank forms", () => {
		expect(normalizePreconditions(undefined)).toEqual([]);
		expect(normalizePreconditions("")).toEqual([]);
		expect(normalizePreconditions("   ")).toEqual([]);
		expect(normalizePreconditions([])).toEqual([]);
		expect(normalizePreconditions("yes")).toEqual(["yes"]);
		expect(normalizePreconditions([" yes ", "", "no"])).toEqual(["yes", "no"]);
	});
});

describe("runCheck exit-code contract", () => {
	test("exit 0 → spawn", async () => {
		const r = await runCheck("yes", { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "passed", code: 0 });
	});

	test("exit 1 → skip the spawn", async () => {
		const r = await runCheck("no", { dir });
		expect(r).toMatchObject({ shouldSpawn: false, reason: "not-met", code: 1 });
	});

	test("exit 254 → still a skip (systemd ExecCondition range)", async () => {
		const r = await runCheck("no-254", { dir });
		expect(r.shouldSpawn).toBe(false);
		expect(r.code).toBe(254);
	});

	// The four fail-open arms. Each one is a way for a check to be broken;
	// none of them may silently stop a cron from running.
	test("exit 255 → unevaluable, spawns anyway", async () => {
		const r = await runCheck("broken", { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "unevaluable" });
		expect(r.detail).toContain("boom");
	});

	test("timeout → unevaluable, spawns anyway", async () => {
		const started = Date.now();
		const r = await runCheck("slow", { dir, timeoutMs: 300 });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "unevaluable" });
		expect(r.detail).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test("missing check → unevaluable, spawns anyway", async () => {
		const r = await runCheck("does-not-exist", { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "unevaluable" });
	});

	test("non-executable check → unevaluable, spawns anyway", async () => {
		const r = await runCheck("not-executable", { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "unevaluable" });
	});

	test("illegal name → invalid, spawns anyway, nothing executed", async () => {
		const r = await runCheck("../yes", { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "invalid" });
	});

	test("arguments arrive as argv, not through a shell", async () => {
		const r = await runCheck("argv --folder=INBOX Mail ;touch pwned", { dir });
		// Whitespace splits into argv entries; `;` is just a character.
		expect(r.shouldSpawn).toBe(false); // args differ → exit 1 → not-met
		expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
	});

	test("PICOCLAW_WORKSPACE_DIR is exported to the check", async () => {
		const withWs = await runCheck("wants-workspace", {
			dir,
			workspaceDir: "/tmp/some-workspace",
		});
		expect(withWs.shouldSpawn).toBe(true);
		const without = await runCheck("wants-workspace", { dir });
		expect(without.shouldSpawn).toBe(false);
	});
});

describe("evaluatePreconditions (OR)", () => {
	test("no precondition → spawn", async () => {
		expect(await evaluatePreconditions(undefined, { dir })).toMatchObject({
			shouldSpawn: true,
			reason: "no-check",
		});
	});

	test("all checks not-met → skip", async () => {
		const r = await evaluatePreconditions(["no", "no-254"], { dir });
		expect(r.shouldSpawn).toBe(false);
	});

	test("any check passing → spawn", async () => {
		const r = await evaluatePreconditions(["no", "yes"], { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "passed" });
	});

	test("an unevaluable check in the chain → spawn", async () => {
		const r = await evaluatePreconditions(["no", "broken"], { dir });
		expect(r).toMatchObject({ shouldSpawn: true, reason: "unevaluable" });
	});

	test("short-circuits: later checks are not run once one passes", async () => {
		fs.rmSync(path.join(dir, "ran-marker"), { force: true });
		const r = await evaluatePreconditions(["yes", "marker"], { dir });
		expect(r.shouldSpawn).toBe(true);
		expect(fs.existsSync(path.join(dir, "ran-marker"))).toBe(false);
	});
});

// Everything above runs fixtures out of a temp directory. These run the files
// that actually ship, through the entry point index.ts wires, with no `dir`
// override in the way — because the way this feature dies quietly is a check
// losing its +x bit in git: every gate then resolves `unevaluable`, fails open,
// and the boots it exists to prevent come back with nothing in the logs but a
// warning nobody reads.
describe("shipped checks", () => {
	const shipped = fs.readdirSync(PRECONDITIONS_DIR);

	test("the directory is not empty and every check is executable", () => {
		expect(shipped.length).toBeGreaterThan(0);
		for (const name of shipped) {
			fs.accessSync(path.join(PRECONDITIONS_DIR, name), fs.constants.X_OK);
		}
	});

	test("heartbeat-stale: fresh → skip, stale → spawn, absent → spawn", async () => {
		const hb = path.join(dir, "heartbeat");
		fs.writeFileSync(hb, "");
		const task = (spec: string) => ({ id: "t-1", precondition: spec });

		expect(
			await checkTaskPrecondition(task(`heartbeat-stale ${hb} 3600`)),
		).toMatchObject({ shouldSpawn: false, reason: "not-met" });
		expect(
			await checkTaskPrecondition(task(`heartbeat-stale ${hb} 0`)),
		).toMatchObject({ shouldSpawn: true, reason: "passed" });
		expect(
			await checkTaskPrecondition(task(`heartbeat-stale ${hb}-absent 3600`)),
		).toMatchObject({ shouldSpawn: true, reason: "passed" });
		expect(await checkTaskPrecondition(task("heartbeat-stale"))).toMatchObject({
			shouldSpawn: true,
			reason: "unevaluable",
		});
	});
});
