import type { ContainerOutput, SessionProfile } from "./types.ts";

/**
 * A chat container lives at most CONTAINER_TIMEOUT. A message piped into one
 * with less than this left can start a run the hard cap then kills mid-answer
 * (10-16: GO arrived with 2-6 min left, killed mid-run). Below this margin the
 * host closes the old container and starts a fresh one on the same session.
 */
export const ROTATE_MARGIN_MS = 15 * 60 * 1000;

export const TIMEOUT_MIDRUN = "timeout_midrun";

export const CUTOFF_NOTICE =
	"⏱️ Cut off at the 60-min container cap in the middle of a run. Send any message to continue.";

export function shouldRotate(
	hardDeadline: number,
	now: number,
	margin: number = ROTATE_MARGIN_MS,
): boolean {
	return hardDeadline - now < margin;
}

/**
 * Is a run in flight? A container starts with its prompt (open). The runner
 * emits type:"result" when a run ends; any later text/tool_use means a run
 * started from a piped message. noteInput() opens one before any output.
 */
export class RunTracker {
	open = true;

	onOutput(output: ContainerOutput): void {
		if (output.type === "result") this.open = false;
		else if (output.type === "text" || output.type === "tool_use")
			this.open = true;
	}

	noteInput(): void {
		this.open = true;
	}
}

/**
 * Outcome of a container killed by the timeout. Idle at the kill = the
 * container simply lived to its cap (success). An open run = the answer was
 * cut off, which must not be filed as success.
 */
export function timeoutOutcome(
	runOpen: boolean,
	newSessionId: string | undefined,
): ContainerOutput {
	return runOpen
		? { status: "error", result: null, error: TIMEOUT_MIDRUN, newSessionId }
		: { status: "success", result: null, newSessionId };
}

/**
 * Where an inbound chat message goes: a new container, the live one, or held
 * for the fresh container that replaces a live one too close to its cap.
 * A container already rotating keeps holding (its replacement is not up yet).
 */
export function routeInbound(
	state:
		| { hardDeadline?: number | undefined; pending?: unknown[] | undefined }
		| undefined,
	now: number,
): "spawn" | "pipe" | "rotate" {
	if (!state) return "spawn";
	if (state.pending) return "rotate";
	if (state.hardDeadline !== undefined && shouldRotate(state.hardDeadline, now))
		return "rotate";
	return "pipe";
}

/**
 * Opt-in Pi Durable for named chats only (default off): PICOCLAW_DURABLE_CHATS
 * is a comma-separated list of chat ids. With it on, a cap-killed run stays
 * pending in <sessionId>.sqlite and the next container resumes it. Rollback =
 * remove the id from the list.
 */
export function withDurable(
	chatId: string,
	profile: SessionProfile | undefined,
	list: string | undefined = process.env["PICOCLAW_DURABLE_CHATS"],
): SessionProfile | undefined {
	const ids = (list ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!ids.includes(chatId)) return profile;
	return {
		...profile,
		extraEnv: { ...profile?.extraEnv, PICOCLAW_RUNNER: "durable" },
	};
}
