export interface BotConfig {
	name: string;
	botToken: string;
	allowedUserId: string;
	defaultModel?: string | undefined;
	defaultEffort?: EffortLevel | undefined;
	anthropicApiKey: string;
	agentlairApiKey?: string | undefined;
}

export interface ImageAttachment {
	/** Base64-encoded image data */
	data: string;
	/** MIME type (e.g. "image/jpeg", "image/png") */
	mediaType: string;
}

export type EffortLevel = "low" | "medium" | "high" | "max" | "xhigh";

export interface SessionProfile {
	/** Surfaced to in-container hooks/gates/scripts as PICOCLAW_PERSONA (e.g. "operator", "evaluator", "sandbox"). */
	persona?: string | undefined;
	/** Workspace-relative path to the system-prompt overlay appended to the base SYSTEM_PROMPT.
	 *  Omitted → "my-prompt.md". Empty string → no overlay (boot without the operator constitution). */
	systemPromptOverlay?: string | undefined;
	/** SDK settingSources. Omitted → ["project", "user"]. Use ["user"] to suppress project CLAUDE.md + project hooks. */
	settingSources?: string[] | undefined;
	/** Env merged into the in-container SDK env AFTER process.env + secrets, so it overrides them. Used to set
	 *  PICOCLAW_PERSONA and to redirect the experiential store (e.g. TURSO_URL/TURSO_AUTH_TOKEN to a blank/clone namespace). */
	extraEnv?: Record<string, string> | undefined;
	/** When true, start a fresh SDK session — ignore any prior sessionId (no resume). */
	freshSession?: boolean | undefined;
}

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
	profile?: SessionProfile | undefined;
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
	profile?: SessionProfile | undefined;
}

export interface SessionData {
	sessionId: string;
	lastActivity: string;
	model?: string | undefined;
	effort?: EffortLevel | undefined;
}
