// AgentLair audit client — write-only access from PicoClaw host.
// Uses @piiiico/agent-logger (https://agentlair.dev/docs/audit-logger).
// The agent container never receives this API key, so it cannot read the audit trail.
//
// Each bot in bots.json must have its own agentlairApiKey for audit logging.
// No global fallback — if a bot has no key, its audit logging is disabled.
import { createAuditLogger } from "@piiiico/agent-logger";
import pino from "pino";

const log = pino({ name: "audit-client" });

type AuditLoggerFn = ReturnType<typeof createAuditLogger>;

// Cache loggers by API key to avoid creating duplicates
const loggerCache = new Map<string, AuditLoggerFn>();

function getLogger(apiKey: string | undefined): AuditLoggerFn {
	if (!apiKey) {
		return getLogger("__silent__");
	}
	const cached = loggerCache.get(apiKey);
	if (cached) return cached;
	const isSilent = apiKey === "__silent__";
	const logger = createAuditLogger("picoclaw", {
		transport: isSilent ? "silent" : "agentlair",
		agentlairApiKey: isSilent ? "" : apiKey,
	});
	loggerCache.set(apiKey, logger);
	return logger;
}

export const audit = {
	/** Call once per bot at startup to log which bots have keys configured. */
	registerBot(botName: string, botApiKey?: string | undefined): void {
		if (botApiKey) {
			log.info({ bot: botName }, "Audit: AgentLair key configured");
		} else {
			log.warn(
				{ bot: botName },
				"Audit: no agentlairApiKey in bots.json, audit logging disabled",
			);
		}
	},

	sessionStart(opts: {
		sessionId: string;
		chatId: string;
		model?: string | undefined;
		sessionType?: string | undefined;
		source?: string | undefined;
		botApiKey?: string | undefined;
	}): void {
		const logger = getLogger(opts.botApiKey);
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
		botApiKey?: string | undefined;
	}): void {
		const logger = getLogger(opts.botApiKey);
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
		botApiKey?: string | undefined;
	}): void {
		const logger = getLogger(opts.botApiKey);
		const toolName =
			opts.eventType === "tool.use"
				? (opts.metadata?.["tool"] as string | undefined)
				: undefined;
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
