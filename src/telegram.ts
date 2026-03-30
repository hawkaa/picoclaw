import pino from "pino";
import { TELEGRAM_POLL_TIMEOUT } from "./config.ts";

const log = pino({ name: "telegram" });

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		from?: { id: number; first_name?: string; username?: string };
		chat: { id: number; type: string };
		date: number;
		text?: string;
		photo?: TelegramPhotoSize[];
		caption?: string;
	};
}

export class TelegramClient {
	private readonly apiBase: string;
	private readonly botToken: string;

	constructor(
		public readonly name: string,
		botToken: string,
		public readonly allowedUserId: string,
	) {
		this.botToken = botToken;
		this.apiBase = `https://api.telegram.org/bot${botToken}`;
	}

	private async api<T>(
		method: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		const res = await fetch(`${this.apiBase}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : null,
		});
		const json = (await res.json()) as {
			ok: boolean;
			result: T;
			description?: string;
		};
		if (!json.ok)
			throw new Error(`Telegram API ${method}: ${json.description}`);
		return json.result;
	}

	async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
		return this.api<TelegramUpdate[]>("getUpdates", {
			offset,
			timeout: TELEGRAM_POLL_TIMEOUT,
			allowed_updates: ["message"],
		});
	}

	async sendMessage(chatId: number | string, text: string): Promise<void> {
		const chunks = splitMessage(text, 4096);
		for (const chunk of chunks) {
			try {
				await this.api("sendMessage", {
					chat_id: chatId,
					text: chunk,
					parse_mode: "Markdown",
				});
			} catch {
				// Retry without Markdown if parse fails
				await this.api("sendMessage", {
					chat_id: chatId,
					text: chunk,
				});
			}
		}
	}

	/**
	 * Send a message and return its message_id.
	 * Used to start a streaming edit-in-place sequence.
	 * Truncates to 4000 chars (leaves room for Telegram overhead).
	 * Returns null on failure (caller falls back to sendMessage).
	 */
	async sendMessageForStream(
		chatId: number | string,
		text: string,
	): Promise<number | null> {
		const safe = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
		try {
			const result = await this.api<{ message_id: number }>("sendMessage", {
				chat_id: chatId,
				text: safe,
				parse_mode: "Markdown",
			});
			return result.message_id;
		} catch {
			try {
				const result = await this.api<{ message_id: number }>("sendMessage", {
					chat_id: chatId,
					text: safe,
				});
				return result.message_id;
			} catch (err) {
				log.warn({ err, chatId }, "sendMessageForStream failed");
				return null;
			}
		}
	}

	/**
	 * Edit an existing message in-place.
	 * Truncates text to 4000 chars to stay within Telegram's limit.
	 * Throws on failure so callers can decide whether to fall back.
	 */
	async editMessageText(
		chatId: number | string,
		messageId: number,
		text: string,
	): Promise<void> {
		const safe = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
		try {
			await this.api("editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text: safe,
				parse_mode: "Markdown",
			});
		} catch {
			// Retry without Markdown
			await this.api("editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text: safe,
			});
		}
	}

	async setMyCommands(
		commands: Array<{ command: string; description: string }>,
	): Promise<void> {
		await this.api("setMyCommands", { commands });
	}

	async getFile(
		fileId: string,
	): Promise<{ file_id: string; file_path: string }> {
		return this.api<{ file_id: string; file_path: string }>("getFile", {
			file_id: fileId,
		});
	}

	async downloadFile(filePath: string): Promise<Buffer> {
		const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
		const res = await fetch(url);
		if (!res.ok)
			throw new Error(
				`Failed to download file: ${res.status} ${res.statusText}`,
			);
		return Buffer.from(await res.arrayBuffer());
	}

	async sendChatAction(
		chatId: number | string,
		action = "typing",
	): Promise<void> {
		await this.api("sendChatAction", { chat_id: chatId, action }).catch(
			(err) => {
				log.debug({ err }, "sendChatAction failed");
			},
		);
	}

	/**
	 * Acknowledge a message with an emoji reaction.
	 * Fires and forgets — a failure is non-fatal and logged at debug level.
	 *
	 * @param chatId   The chat containing the message.
	 * @param messageId  The message to react to.
	 * @param emoji    A Telegram emoji reaction string (default: "👀").
	 */
	async setMessageReaction(
		chatId: number | string,
		messageId: number,
		emoji = "👀",
	): Promise<void> {
		await this.api("setMessageReaction", {
			chat_id: chatId,
			message_id: messageId,
			reaction: [{ type: "emoji", emoji }],
		}).catch((err) => {
			log.debug({ err }, "setMessageReaction failed");
		});
	}
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
