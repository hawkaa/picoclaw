import pino from "pino";
import { TELEGRAM_POLL_TIMEOUT } from "./config.ts";

const log = pino({ name: "telegram" });

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		from?: { id: number; first_name?: string; username?: string };
		chat: { id: number; type: string };
		date: number;
		text?: string;
	};
}

async function api<T>(
	method: string,
	body?: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : null,
	});
	const json = (await res.json()) as {
		ok: boolean;
		result: T;
		description?: string;
	};
	if (!json.ok) throw new Error(`Telegram API ${method}: ${json.description}`);
	return json.result;
}

export async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
	return api<TelegramUpdate[]>("getUpdates", {
		offset,
		timeout: TELEGRAM_POLL_TIMEOUT,
		allowed_updates: ["message"],
	});
}

export async function sendMessage(
	chatId: number | string,
	text: string,
): Promise<void> {
	// Telegram max message length is 4096
	const chunks = splitMessage(text, 4096);
	for (const chunk of chunks) {
		try {
			await api("sendMessage", {
				chat_id: chatId,
				text: chunk,
				parse_mode: "Markdown",
			});
		} catch {
			// Retry without Markdown if parse fails
			await api("sendMessage", {
				chat_id: chatId,
				text: chunk,
			});
		}
	}
}

export async function setMyCommands(
	commands: Array<{ command: string; description: string }>,
): Promise<void> {
	await api("setMyCommands", { commands });
}

export async function sendChatAction(
	chatId: number | string,
	action = "typing",
): Promise<void> {
	await api("sendChatAction", { chat_id: chatId, action }).catch((err) => {
		log.debug({ err }, "sendChatAction failed");
	});
}

function splitMessage(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}
		// Try to split at newline
		let splitAt = remaining.lastIndexOf("\n", maxLen);
		if (splitAt <= 0) splitAt = maxLen;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt);
	}
	return chunks;
}
