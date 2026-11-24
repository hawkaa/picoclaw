import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCheck } from "./precondition.ts";

// The shipped check, spawned for real against a local stand-in for the
// Moltbook API. The positive control is the case the gate exists to protect:
// an unanswered comment OLDER than the watermark must still spawn.

const ME = "pico_amdal";
const POST = "11111111-1111-1111-1111-111111111111";
const FOREIGN = "22222222-2222-2222-2222-222222222222";
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

type Comment = {
	id: string;
	created_at: string;
	content: string;
	author: { name: string };
	replies: Comment[];
};
const c = (
	id: string,
	author: string,
	hoursAgo: number,
	content = "a question?",
	replies: Comment[] = [],
): Comment => ({
	id,
	created_at: ago(hoursAgo),
	content,
	author: { name: author },
	replies,
});

interface World {
	comments: Record<string, Comment[]>;
	notifications?: unknown[];
	activity?: { post_id: string; post_title: string }[];
	status?: number;
}
let world: World = { comments: {} };

let server: ReturnType<typeof Bun.serve>;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "picoclaw-molt-"));

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			if (world.status) return new Response("down", { status: world.status });
			const u = new URL(req.url);
			const p = u.pathname.replace(/^\/api\/v1/, "");
			if (req.headers.get("authorization") !== "Bearer k-test")
				return new Response("auth", { status: 401 });
			if (p === "/home")
				return Response.json({
					your_account: { name: ME },
					activity_on_your_posts: world.activity ?? [],
				});
			if (p === "/agents/me")
				return Response.json({ agent: { posts_count: 1 } });
			if (p === "/posts" && u.searchParams.get("author") === ME)
				return Response.json({
					posts: [{ id: POST, title: "ours", author: { name: ME } }],
				});
			if (p === "/notifications")
				return Response.json({ notifications: world.notifications ?? [] });
			const m = p.match(/^\/posts\/([^/]+)\/comments$/);
			if (m?.[1])
				return Response.json({
					comments: world.comments[m[1]] ?? [],
					has_more: false,
				});
			return new Response("no route", { status: 404 });
		},
	});
	process.env["MOLTBOOK_API_BASE"] = `http://localhost:${server.port}/api/v1`;
	fs.mkdirSync(path.join(ws, ".secrets"));
	fs.mkdirSync(path.join(ws, ".state"));
	fs.writeFileSync(
		path.join(ws, ".secrets/moltbook.env"),
		"MOLTBOOK_API_KEY=k-test\n",
	);
});

afterAll(() => {
	server.stop(true);
	delete process.env["MOLTBOOK_API_BASE"];
	fs.rmSync(ws, { recursive: true, force: true });
});

const SPEC =
	"moltbook-activity --env=.secrets/moltbook.env --seen=.state/seen.json";
async function gate(seen: Record<string, string> | null, w: World) {
	world = w;
	const file = path.join(ws, ".state/seen.json");
	if (seen) fs.writeFileSync(file, JSON.stringify(seen));
	else fs.rmSync(file, { force: true });
	const out = await runCheck(SPEC, { workspaceDir: ws });
	return out.reason === "passed" ? 0 : out.reason === "not-met" ? 1 : 255;
}

describe("moltbook-activity", () => {
	const question = c("q1", "alice", 5);
	const wmAfter = { [POST]: ago(1) }; // the question is older than the watermark

	test("POSITIVE CONTROL: unanswered comment behind the watermark → spawn", async () => {
		expect(await gate(wmAfter, { comments: { [POST]: [question] } })).toBe(0);
	});

	test("the same comment answered by us → skip", async () => {
		const answered = c("q1", "alice", 5, "a question?", [
			c("r1", ME, 4, "answer"),
		]);
		expect(await gate(wmAfter, { comments: { [POST]: [answered] } })).toBe(1);
	});

	test("the same comment declined → skip", async () => {
		expect(
			await gate(
				{ ...wmAfter, "declined:q1": "praise x" },
				{ comments: { [POST]: [question] } },
			),
		).toBe(1);
	});

	test("older than 72h and behind the watermark → skip", async () => {
		expect(
			await gate(wmAfter, { comments: { [POST]: [c("old", "alice", 80)] } }),
		).toBe(1);
	});

	test("a comment newer than the watermark → spawn", async () => {
		expect(
			await gate({ [POST]: ago(10) }, { comments: { [POST]: [question] } }),
		).toBe(0);
	});

	test("empty world → skip", async () => {
		expect(await gate({}, { comments: {} })).toBe(1);
	});

	test("foreign thread: new comment not addressed to us → skip; @mention → spawn", async () => {
		const activity = [{ post_id: FOREIGN, post_title: "theirs" }];
		const chatter = [c("f1", "bob", 1, "unrelated")];
		expect(await gate({}, { activity, comments: { [FOREIGN]: chatter } })).toBe(
			1,
		);
		const mention = [c("f2", "bob", 1, `@${ME} what do you measure?`)];
		expect(await gate({}, { activity, comments: { [FOREIGN]: mention } })).toBe(
			0,
		);
	});

	test("unread notification newer than its watermark → spawn; older and rendered → skip", async () => {
		const n = {
			isRead: false,
			type: "mention",
			createdAt: ago(1),
			relatedPostId: POST,
			relatedCommentId: "q1",
		};
		const comments = {
			[POST]: [c("q1", "alice", 1, "hi", [c("r", ME, 0.5, "hey")])],
		};
		expect(
			await gate(
				{ [POST]: ago(0.1), "notes:wm": ago(2) },
				{ comments, notifications: [n] },
			),
		).toBe(0);
		expect(
			await gate(
				{ [POST]: ago(0.1), "notes:wm": ago(0) },
				{ comments, notifications: [n] },
			),
		).toBe(1);
	});

	test("notification for a comment no tree renders → spawn", async () => {
		const n = {
			isRead: false,
			type: "comment_reply",
			createdAt: ago(3),
			relatedPostId: POST,
			relatedCommentId: "deep",
		};
		expect(
			await gate(
				{ "notes:wm": ago(0) },
				{ comments: { [POST]: [] }, notifications: [n] },
			),
		).toBe(0);
		expect(
			await gate(
				{ "notes:wm": ago(0), "unserved:deep": ago(3) },
				{ comments: { [POST]: [] }, notifications: [n] },
			),
		).toBe(1);
	});

	test("no watermark file → spawn (never ran)", async () => {
		expect(await gate(null, { comments: {} })).toBe(0);
	});

	test("API down → fail open", async () => {
		expect(await gate({}, { comments: {}, status: 503 })).toBe(255);
	});
});
