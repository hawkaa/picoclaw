export interface ContainerInput {
	prompt: string;
	sessionId?: string | undefined;
	chatId: string;
	isScheduledTask?: boolean;
	caller?: { name: string; source: "telegram" | "scheduler" } | undefined;
	secrets?: Record<string, string> | undefined;
}

export interface ContainerOutput {
	status: "success" | "error";
	result: string | null;
	newSessionId?: string | undefined;
	error?: string;
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
}

export interface SessionData {
	sessionId: string;
	lastActivity: string;
}
