// AgentLair audit client — write-only access from PicoClaw host.
// Uses @piiiico/agent-logger (https://agentlair.dev/docs/audit-logger).
// The agent container never receives this API key, so it cannot read the audit trail.
import fs from "node:fs";
import pino from "pino";
import { createAuditLogger } from "@piiiico/agent-logger";

const log = pino({ name: "audit-client" });

function loadApiKey(): string {
	const fromEnv = process.env["AGENTLAIR_API_KEY"];
	if (fromEnv) return fromEnv;
	try {
		const raw = fs.readFileSync("/workspace/.secrets/agentlair.env", "utf-8");
		for (const line of raw.split("\n")) {
			const match = line.match(/^AGENTLAIR_API_KEY=(.+)$/);
			if (match?.[1]) return match[1].trim();
		}
	} catch {
		/* ignore */
	}
	return "";
}

const apiKey = loadApiKey();

if (apiKey) {
	log.info("Audit client initialized (AgentLair)");
} else {
	log.warn("Audit client: no AGENTLAIR_API_KEY found, audit logging disabled");
}

const logger = createAuditLogger("picoclaw", {
	transport: apiKey ? "agentlair" : "silent",
	agentlairApiKey: apiKey,
});

export const audit = {
	sessionStart(opts: {
		sessionId: string;
		chatId: string;
		model?: string | undefined;
		sessionType?: string | undefined;
		source?: string | undefined;
	}): void {
		logger({
			action: "session.start",
			metadata: {
				session_id: opts.sessionId,
				chat_id: opts.chatId,
				model: opts.model ?? null,
				session_type: opts.sessionType ?? null,
				source: opts.source ?? null,
			},
		}).catch((err: unknown) => {
			log.debug({ err }, "Audit fire-and-forget failed (ignored)");
		});
	},

	sessionEnd(opts: {
		sessionId: string;
		endReason?: string | undefined;
	}): void {
		logger({
			action: "session.end",
			metadata: {
				session_id: opts.sessionId,
				end_reason: opts.endReason ?? null,
			},
		}).catch((err: unknown) => {
			log.debug({ err }, "Audit fire-and-forget failed (ignored)");
		});
	},

	event(opts: {
		sessionId: string;
		eventType: string;
		description?: string | undefined;
		metadata?: Record<string, unknown> | undefined;
	}): void {
		const toolName = opts.eventType === "tool.use" ? (opts.metadata?.["tool"] as string | undefined) : undefined;
		logger({
			action: opts.eventType,
			...(toolName ? { tool: toolName } : {}),
			metadata: {
				session_id: opts.sessionId,
				description: opts.description ?? null,
				...opts.metadata,
			},
		}).catch((err: unknown) => {
			log.debug({ err }, "Audit fire-and-forget failed (ignored)");
		});
	},
};
