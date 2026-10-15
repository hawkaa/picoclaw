import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Packet = { type?: string; result?: string | null; newSessionId?: string; status: string };

function packets(stdout: string): Packet[] {
	const out: Packet[] = [];
	const re = /---PICOCLAW_OUTPUT_START---\n(.*?)\n---PICOCLAW_OUTPUT_END---/gs;
	for (const m of stdout.matchAll(re)) out.push(JSON.parse(m[1] as string));
	return out;
}

const fixture = path.join(import.meta.dir, "crash-fixture.ts");

test("a run killed mid-tool is finished by the next container", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-"));
	fs.mkdirSync(path.join(root, "ws"));
	fs.mkdirSync(path.join(root, "ipc"));

	const a = Bun.spawnSync(["bun", fixture, "crash", root]);
	expect(a.signalCode).toBe("SIGKILL");
	const files = fs.readdirSync(path.join(root, "agent", "durable"));
	const db = files.find((f) => f.endsWith(".sqlite"));
	expect(db).toBeDefined();
	const sessionId = (db as string).replace(/\.sqlite$/, "");
	// Container A only ever saw the tool start; it never got a result packet.
	expect(packets(a.stdout.toString()).map((p) => p.type)).toEqual(["tool_use"]);

	// Container B: same session. Close it once its prompt is answered.
	const b = Bun.spawn(["bun", fixture, "resume", root, sessionId], {
		stdout: "pipe",
		stderr: "pipe",
	});
	let out = "";
	const reader = b.stdout.getReader();
	const decoder = new TextDecoder();
	while (!out.includes("answered new prompt") || !out.match(/"type":"result"/g)) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	fs.writeFileSync(path.join(root, "ipc", "_close"), "");
	await b.exited;
	const texts = packets(out).filter((p) => p.type === "text").map((p) => p.result);
	expect(texts).toEqual(["recovered interrupted-tool-seen", "answered new prompt"]);
	expect(packets(out).find((p) => p.type === "result")?.newSessionId).toBe(sessionId);
	// The killed bash never finished its side effect, and was not replayed.
	expect(fs.existsSync(path.join(root, "ws", "marker.txt"))).toBe(false);
}, 30_000);
