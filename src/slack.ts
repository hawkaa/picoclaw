/**
 * Slack inbound for PicoClaw. Socket Mode on the HOST (same place as Telegram
 * polling). Tokens from env, never bots.json, never the container.
 *
 * Channel @pico mention → new thread → one agent session. Thread replies
 * continue that session (no re-tag). Volume is the operator's existing chat.
 *
 * Leading space before `/` avoids Slack slash-command intercept:
 * ` /new grok xhigh` starts a new container; ` /switch grok xhigh` keeps
 * this container and session and changes the model. `@pico grok xhigh …`
 * on the mention line also selects model for a new thread.
 */
import pino from "pino";

import { MODEL_ALIASES, parseEffortLevel } from "./config.ts";
import type { EffortLevel } from "./types.ts";

const log = pino({ name: "slack" });

/** assistant.threads.setStatus times out after ~2 min; refresh under that. */
export const SLACK_STATUS_INTERVAL_MS = 60_000;

const SELF_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;

export type SlackInbound = {
	channel: string;
	user: string;
	text: string;
	ts: string;
	/** Parent ts when unthreaded; thread_ts when a reply. */
	threadTs: string;
	isDm: boolean;
	/** True when this event is a reply inside an existing thread. */
	isThreadReply: boolean;
	selfUserId: string;
};

export function slackRuntimeId(channel: string, threadTs: string): string {
	return `slack-${channel}-${threadTs.replaceAll(".", "-")}`;
}

/** Docker --name: [a-zA-Z0-9][a-zA-Z0-9_.-]+ */
export function dockerSafeId(id: string): string {
	const s = id.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "x");
	return s.slice(0, 80) || "x";
}

export function mentionedSelf(text: string, selfUserId: string): boolean {
	return text.includes(`<@${selfUserId}>`) || text.includes(`<@${selfUserId}|`);
}

export function stripSelfMentions(text: string, selfUserId: string): string {
	return text
		.replace(SELF_MENTION_RE, (full, id: string) =>
			id === selfUserId ? " " : full,
		)
		.replace(/[ \t]+/g, " ")
		.trim();
}

export type SlackCommand = "new" | "switch";

/**
 * Strip @pico, detect `/new` or `/switch`, then consume leading model/effort
 * aliases. Remaining text is the prompt.
 */
export function parseSlackPrompt(
	text: string,
	selfUserId?: string,
): {
	command?: SlackCommand | undefined;
	model?: string | undefined;
	effort?: EffortLevel | undefined;
	rest: string;
} {
	let body = (selfUserId ? stripSelfMentions(text, selfUserId) : text).trim();
	let command: SlackCommand | undefined;
	if (/^\/new\b/i.test(body)) {
		command = "new";
		body = body.replace(/^\/new\b/i, "").trim();
	} else if (/^\/switch\b/i.test(body)) {
		command = "switch";
		body = body.replace(/^\/switch\b/i, "").trim();
	}
	const lines = body.split("\n");
	const first = lines[0] ?? "";
	const tokens = first.split(/\s+/).filter(Boolean);
	let model: string | undefined;
	let effort: EffortLevel | undefined;
	let i = 0;
	const commandExplicit = command !== undefined;
	while (i < tokens.length) {
		const tok = tokens[i];
		if (!tok) break;
		const parsed = parseEffortLevel(tok);
		if (
			parsed &&
			(commandExplicit || model || parsed === "xhigh" || parsed === "max")
		) {
			effort = parsed;
			i++;
			continue;
		}
		if (
			!model &&
			(MODEL_ALIASES[tok.toLowerCase()] !== undefined || tok.includes("/"))
		) {
			model = tok.toLowerCase();
			i++;
			continue;
		}
		break;
	}
	const restFirst = tokens.slice(i).join(" ");
	const rest = [restFirst, ...lines.slice(1)].join("\n").trim();
	return { command, model, effort, rest };
}

export function shouldIgnoreSlackEvent(
	event: {
		type?: string;
		subtype?: string;
		bot_id?: string;
		user?: string;
		text?: string;
		thread_ts?: string;
		ts?: string;
		channel?: string;
	},
	selfBotId: string,
	selfUserId: string,
): boolean {
	if (event.type !== "message" && event.type !== "app_mention") return true;
	if (event.subtype && event.subtype !== "bot_message") return true;
	if (event.bot_id && event.bot_id === selfBotId) return true;
	if (event.user && event.user === selfUserId) return true;
	if (!event.text?.trim()) return true;
	const isDm = (event.channel ?? "").startsWith("D");
	const isThreadReply = Boolean(
		event.thread_ts && event.ts && event.thread_ts !== event.ts,
	);
	if (
		!isDm &&
		!isThreadReply &&
		!mentionedSelf(event.text, selfUserId) &&
		event.type !== "app_mention"
	) {
		return true;
	}
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

/**
 * Slack AI "is thinking…" indicator. Auto-clears when we post a reply.
 * Empty status clears without posting. Best-effort — never throws.
 */
export async function slackSetStatus(
	botToken: string,
	channel: string,
	threadTs: string,
	status: string,
): Promise<void> {
	const res = await fetch("https://slack.com/api/assistant.threads.setStatus", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${botToken}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({
			channel_id: channel,
			thread_ts: threadTs,
			status,
		}),
	});
	const data = (await res.json()) as { ok: boolean; error?: string };
	if (!data.ok) {
		log.warn({ error: data.error, channel }, "slack setStatus failed");
	}
}

type SlackHandler = (msg: SlackInbound) => Promise<void>;

/** Dedup app_mention + message for the same channel+ts. */
const recentEvents = new Map<string, number>();

function alreadySeen(channel: string, ts: string): boolean {
	const now = Date.now();
	const key = `${channel}:${ts}`;
	if (recentEvents.has(key)) return true;
	recentEvents.set(key, now);
	if (recentEvents.size > 500) {
		for (const [k, t] of recentEvents) {
			if (now - t > 60_000) recentEvents.delete(k);
		}
	}
	return false;
}

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
			const wait = Promise.withResolvers<void>();
			setTimeout(wait.resolve, 5000);
			await wait.promise;
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
	const openedWs = Promise.withResolvers<void>();
	ws.addEventListener("open", () => openedWs.resolve(), { once: true });
	ws.addEventListener("error", () => openedWs.reject(new Error("ws error")), {
		once: true,
	});
	await openedWs.promise;

	const closed = Promise.withResolvers<void>();
	ws.addEventListener("close", () => closed.resolve());
	ws.addEventListener("message", (ev) => {
		void handleSocketFrame(String(ev.data), ws, opts);
	});
	await closed.promise;
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
	if (alreadySeen(channel, ts)) return;
	const threadTs = event["thread_ts"] || ts;
	const msg: SlackInbound = {
		channel,
		user: event["user"] || event["bot_id"] || "unknown",
		text,
		ts,
		threadTs,
		isDm: channel.startsWith("D"),
		isThreadReply: Boolean(event["thread_ts"] && event["thread_ts"] !== ts),
		selfUserId: opts.selfUserId,
	};
	try {
		await opts.onMessage(msg);
	} catch (err) {
		log.error({ err, channel }, "Slack onMessage failed");
	}
}
