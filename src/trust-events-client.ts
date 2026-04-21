// AgentLair trust events client — reports behavioral events to the trust engine.
// Uses RFC-003 (Behavioral Event Ingestion) schema.
// Auth: bot's API key (operator-submitted events on behalf of the agent).
// Fire-and-forget: errors are logged at debug level and never block the session.
import { randomUUID } from "node:crypto";
import pino from "pino";

const log = pino({ name: "trust-events" });

const AGENTLAIR_BASE = "https://agentlair.dev";
const SDK_VERSION = "picoclaw/1.0";

// RFC-003 § 2.1 — event envelope
type EventCategory =
	| "tool"
	| "resource"
	| "auth"
	| "session"
	| "escalation"
	| "delegation"
	| "error";

type EventResult = "success" | "failure" | "denied" | "timeout";

interface BehavioralEvent {
	event_id: string;
	timestamp: string;
	category: EventCategory;
	action: string;
	result: EventResult;
	resource_type?: string | undefined;
	duration_ms?: number | undefined;
	error_code?: string | undefined;
	scope_used?: string | undefined;
	metadata?: Record<string, string | number | boolean> | undefined;
}

/**
 * Fire-and-forget: post behavioral events to AgentLair trust engine.
 *
 * Uses the bot's API key (operator-submitted mode: RFC-003 § 3.4).
 * Returns immediately; HTTP call happens in background.
 */
function reportTrustEvents(opts: {
	botApiKey: string | undefined;
	events: BehavioralEvent[];
	sessionId?: string | undefined;
}): void {
	if (!opts.botApiKey || opts.events.length === 0) return;

	const body = {
		events: opts.events,
		sdk_version: SDK_VERSION,
		...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
	};

	fetch(`${AGENTLAIR_BASE}/v1/events`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${opts.botApiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	})
		.then(async (res) => {
			if (!res.ok) {
				const text = await res.text().catch(() => "(unreadable)");
				log.debug(
					{ status: res.status, body: text.slice(0, 200) },
					"Trust event report non-OK response (ignored)",
				);
			}
		})
		.catch((err: unknown) => {
			log.debug({ err }, "Trust event report fetch error (ignored)");
		});
}

// ---- Session lifecycle events ----

/**
 * Report session.start to the trust engine.
 * Call once per session, on first detection of a new session ID.
 */
export function trustReportSessionStart(opts: {
	botApiKey: string | undefined;
	sessionId: string | undefined;
	sessionType?: string | undefined;
	source?: string | undefined;
}): void {
	const metadata: Record<string, string> = {};
	if (opts.sessionType !== undefined)
		metadata["session_type"] = opts.sessionType;
	if (opts.source !== undefined) metadata["source"] = opts.source;

	const event: BehavioralEvent = {
		event_id: randomUUID(),
		timestamp: new Date().toISOString(),
		category: "session",
		action: "start",
		result: "success",
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};

	reportTrustEvents({
		botApiKey: opts.botApiKey,
		sessionId: opts.sessionId,
		events: [event],
	});
}

/**
 * Report session.end to the trust engine.
 * Call once per session, when the container exits.
 */
export function trustReportSessionEnd(opts: {
	botApiKey: string | undefined;
	sessionId: string | undefined;
	endReason?: string | undefined;
}): void {
	const metadata: Record<string, string> = {};
	if (opts.endReason !== undefined) metadata["end_reason"] = opts.endReason;

	const event: BehavioralEvent = {
		event_id: randomUUID(),
		timestamp: new Date().toISOString(),
		category: "session",
		action: "end",
		result: "success",
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};

	reportTrustEvents({
		botApiKey: opts.botApiKey,
		sessionId: opts.sessionId,
		events: [event],
	});
}

// ---- Tool use events ----

/**
 * Report a tool invocation to the trust engine.
 * Call once per tool_use output from the container.
 */
export function trustReportToolUse(opts: {
	botApiKey: string | undefined;
	sessionId: string | undefined;
	toolName: string;
}): void {
	const event: BehavioralEvent = {
		event_id: randomUUID(),
		timestamp: new Date().toISOString(),
		category: "tool",
		action: opts.toolName,
		result: "success",
		resource_type: "tool",
	};

	reportTrustEvents({
		botApiKey: opts.botApiKey,
		sessionId: opts.sessionId,
		events: [event],
	});
}
