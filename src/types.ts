export interface BotConfig {
	name: string;
	botToken: string;
	allowedUserId: string;
	defaultModel?: string | undefined;
	defaultEffort?: EffortLevel | undefined;
	anthropicApiKey: string;
	/**
	 * AgentLair API key. When set, the bot opts into signed identity, audit
	 * telemetry, and PoPA continuity attestation. Omit to run PicoClaw
	 * without external identity (default for self-hosted setups).
	 */
	agentlairApiKey?: string | undefined;
	/**
	 * Per-bot toggle for AAT (Agent Auth Token) issuance. Defaults to `true`
	 * when `agentlairApiKey` is set. Set to `false` to keep audit/PoPA but
	 * skip per-session JWT issuance.
	 */
	agentlairAAT?: boolean | undefined;
	/**
	 * Per-bot toggle for audit telemetry forwarding. Defaults to `true` when
	 * `agentlairApiKey` is set. Set to `false` to disable audit while keeping
	 * AAT/PoPA.
	 */
	agentlairAudit?: boolean | undefined;
	/**
	 * Per-bot toggle for PoPA enrollment. Defaults to `true` when
	 * `agentlairApiKey` is set. Set to `false` to skip enrollment for this
	 * bot (no continuity streak will accumulate).
	 */
	agentlairPoPA?: boolean | undefined;
	/**
	 * Principal DID for this bot. Auto-derived as
	 * `did:web:agentlair.dev:picoclaw:<botName>` if omitted. Override to
	 * point this bot at an existing DID document.
	 */
	agentlairPrincipal?: string | undefined;
}

export interface ImageAttachment {
	/** Base64-encoded image data */
	data: string;
	/** MIME type (e.g. "image/jpeg", "image/png") */
	mediaType: string;
}

export type EffortLevel = "low" | "medium" | "high" | "max" | "xhigh";

export interface ContainerInput {
	prompt: string;
	sessionId?: string | undefined;
	chatId: string;
	isScheduledTask?: boolean;
	caller?: { name: string; source: "telegram" | "scheduler" } | undefined;
	secrets?: Record<string, string> | undefined;
	model?: string | undefined;
	anthropicApiKey?: string | undefined;
	agentlairAAT?: string | undefined;
	images?: ImageAttachment[] | undefined;
	effort?: EffortLevel | undefined;
}

export interface ContainerOutput {
	status: "success" | "error";
	result: string | null;
	newSessionId?: string | undefined;
	error?: string;
	type?: "text" | "result" | "tool_use" | undefined;
	toolName?: string | undefined;
	toolInput?: Record<string, unknown> | undefined;
}

export interface ContainerState {
	proc: import("child_process").ChildProcess;
	containerName: string;
	chatId: string;
	sessionId?: string | undefined;
	lastActivity: number;
}

export interface ScheduledTask {
	id: string;
	chatId: string;
	label?: string | undefined;
	prompt: string;
	schedule_type: "cron" | "interval" | "once";
	schedule_value: string;
	next_run: string | null;
	status: "active" | "paused";
	created_at: string;
	model?: string | undefined;
	effort?: EffortLevel | undefined;
}

export interface SessionData {
	sessionId: string;
	lastActivity: string;
	model?: string | undefined;
	effort?: EffortLevel | undefined;
}
