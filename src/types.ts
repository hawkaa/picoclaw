export interface BotConfig {
	name: string;
	botToken: string;
	allowedUserId: string;
	defaultModel?: string | undefined;
	anthropicApiKey: string;
}

export interface ImageAttachment {
	/** Base64-encoded image data */
	data: string;
	/** MIME type (e.g. "image/jpeg", "image/png") */
	mediaType: string;
}

export interface ContainerInput {
	prompt: string;
	sessionId?: string | undefined;
	chatId: string;
	isScheduledTask?: boolean;
	caller?: { name: string; source: "telegram" | "scheduler" } | undefined;
	secrets?: Record<string, string> | undefined;
	model?: string | undefined;
	effort?: string | undefined;
	anthropicApiKey?: string | undefined;
	images?: ImageAttachment[] | undefined;
}

export interface ContainerOutput {
	status: "success" | "error";
	result: string | null;
	newSessionId?: string | undefined;
	error?: string;
	type?: "text" | "result" | undefined;
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
	effort?: string | undefined;
}

export interface SessionData {
	sessionId: string;
	lastActivity: string;
	model?: string | undefined;
}
