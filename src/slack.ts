/**
 * Slack inbound for PicoClaw. Socket Mode on the HOST (same place as Telegram
 * polling). Tokens from env, never bots.json, never the container.
 *
 * Thread_ts is the unit of context: one Slack thread → one agent session.
 * The workspace volume is the operator's existing chat, not a new empty disk.
 */
import pino from "pino";

import { parseEffortLevel } from "./config.ts";
import type { EffortLevel } from "./types.ts";

const log = pino({ name: "slack" });

export type SlackInbound = {
	channel: string;
	user: string;
	text: string;
	ts: string;
	/** Parent ts when unthreaded; thread_ts when a reply. */
	threadTs: string;
	isDm: boolean;
};

export function slackRuntimeId(channel: string, threadTs: string): string {
	return `slack-${channel}-${threadTs.replaceAll(".", "-")}`;
}

/** Docker --name: [a-zA-Z0-9][a-zA-Z0-9_.-]+ */
export function dockerSafeId(id: string): string {
	const s = id.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "x");
	return s.slice(0, 80) || "x";
}

export function parseLeadingModel(text: string): {
	model?: string;
	effort?: EffortLevel;
	rest: string;
} {
	const lines = text.split("\n");
	const first = lines[0]?.trim() ?? "";
	if (!first.startsWith("/new")) {
		return { rest: text };
	}
	const args = first.slice("/new".length).trim().split(/\s+/).filter(Boolean);
	const out: { model?: string; effort?: EffortLevel; rest: string } = {
		rest: lines.slice(1).join("\n").trim(),
	};
	for (const arg of args) {
		const parsed = parseEffortLevel(arg);
		if (parsed) {
			out.effort = parsed;
			continue;
		}
		if (!out.model) out.model = arg;
	}
	return out;
}

export function shouldIgnoreSlackEvent(
	event: {
		type?: string;
		subtype?: string;
		bot_id?: string;
		user?: string;
		text?: string;
	},
	selfBotId: string,
	selfUserId: string,
): boolean {
	if (event.type !== "message") return true;
	if (event.subtype && event.subtype !== "bot_message") return true;
	if (event.bot_id && event.bot_id === selfBotId) return true;
	if (event.user && event.user === selfUserId) return true;
	if (!event.text?.trim()) return true;
	return false;
}

export async function slackPostMessage(
	botToken: string,
	channel: string,
	text: string,
	threadTs: string,
): Promise<void> {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += 3900) {
		chunks.push(text.slice(i, i + 3900));
	}
	for (const chunk of chunks) {
		const res = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${botToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				channel,
				text: chunk,
				thread_ts: threadTs,
			}),
		});
		const data = (await res.json()) as { ok: boolean; error?: string };
		if (!data.ok) {
			throw new Error(`chat.postMessage: ${data.error ?? res.status}`);
		}
	}
}

type SlackHandler = (msg: SlackInbound) => Promise<void>;

/**
 * Long-running Socket Mode loop. Mirrors pollBot: retry on failure, never
 * throw out to main.
 */
export async function startSlackSocket(opts: {
	botToken: string;
	appToken: string;
	selfBotId: string;
	selfUserId: string;
	onMessage: SlackHandler;
}): Promise<void> {
	log.info("Starting Slack Socket Mode...");
	for (;;) {
		try {
			await runOneConnection(opts);
		} catch (err) {
			log.error({ err }, "Slack socket error, retrying in 5s");
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

async function runOneConnection(opts: {
	botToken: string;
	appToken: string;
	selfBotId: string;
	selfUserId: string;
	onMessage: SlackHandler;
}): Promise<void> {
	const opened = await fetch("https://slack.com/api/apps.connections.open", {
		method: "POST",
		headers: { Authorization: `Bearer ${opts.appToken}` },
	});
	const body = (await opened.json()) as {
		ok: boolean;
		url?: string;
		error?: string;
	};
	if (!body.ok || !body.url) {
		throw new Error(`apps.connections.open: ${body.error ?? opened.status}`);
	}

	const ws = new WebSocket(body.url);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("ws error")), {
			once: true,
		});
	});

	await new Promise<void>((resolve) => {
		ws.addEventListener("close", () => resolve());
		ws.addEventListener("message", (ev) => {
			void handleSocketFrame(String(ev.data), ws, opts);
		});
	});
}

async function handleSocketFrame(
	raw: string,
	ws: WebSocket,
	opts: {
		selfBotId: string;
		selfUserId: string;
		onMessage: SlackHandler;
	},
): Promise<void> {
	let frame: {
		type?: string;
		envelope_id?: string;
		payload?: { event?: Record<string, string> };
	};
	try {
		frame = JSON.parse(raw) as typeof frame;
	} catch {
		return;
	}
	if (frame.type === "hello") return;
	if (frame.envelope_id) {
		ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
	}
	if (frame.type !== "events_api") return;
	const event = frame.payload?.event;
	if (!event) return;
	if (shouldIgnoreSlackEvent(event, opts.selfBotId, opts.selfUserId)) return;
	const channel = event["channel"];
	const ts = event["ts"];
	const text = event["text"];
	if (!channel || !ts || !text) return;
	const threadTs = event["thread_ts"] || ts;
	const msg: SlackInbound = {
		channel,
		user: event["user"] || event["bot_id"] || "unknown",
		text,
		ts,
		threadTs,
		isDm: channel.startsWith("D"),
	};
	try {
		await opts.onMessage(msg);
	} catch (err) {
		log.error({ err, channel }, "Slack onMessage failed");
	}
}
