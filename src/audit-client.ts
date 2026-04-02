// AgentLair audit client — write-only access from PicoClaw host.
// The agent container never receives this API key, so it cannot read the audit trail.
import fs from "node:fs";
import pino from "pino";

const log = pino({ name: "audit-client" });

const AGENTLAIR_BASE = process.env["AGENTLAIR_URL"] ?? "https://agentlair.dev";

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

class AuditClient {
	private readonly apiKey: string;

	constructor() {
		this.apiKey = loadApiKey();
		if (this.apiKey) {
			log.info("Audit client initialized (AgentLair)");
		} else {
			log.warn(
				"Audit client: no AGENTLAIR_API_KEY found, audit logging disabled",
			);
		}
	}

	private fire(path: string, body: Record<string, unknown>): void {
		if (!this.apiKey) return;
		fetch(`${AGENTLAIR_BASE}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		}).catch((err: unknown) => {
			log.debug({ err, path }, "Audit fire-and-forget failed (ignored)");
		});
	}

	sessionStart(opts: {
		sessionId: string;
		chatId: string;
		model?: string | undefined;
		sessionType?: string | undefined;
		source?: string | undefined;
	}): void {
		this.fire("/v1/sessions/start", {
			session_id: opts.sessionId,
			model: opts.model ?? null,
			session_type: opts.sessionType ?? null,
			source: opts.source ?? null,
		});
	}

	sessionEnd(opts: {
		sessionId: string;
		endReason?: string | undefined;
	}): void {
		this.fire("/v1/sessions/end", {
			session_id: opts.sessionId,
			end_reason: opts.endReason ?? null,
		});
	}

	event(opts: {
		sessionId: string;
		eventType: string;
		description?: string | undefined;
		metadata?: Record<string, unknown> | undefined;
	}): void {
		this.fire("/v1/sessions/event", {
			session_id: opts.sessionId,
			event_type: opts.eventType,
			description: opts.description ?? null,
			metadata: opts.metadata ?? null,
		});
	}
}

export const audit = new AuditClient();
