import fs from "node:fs";

/**
 * Host-side alarm for "the fleet is dark".
 *
 * Every container session ends in spawnContainer's result promise. When N of
 * them fail in a row, the host sends one Telegram line. The host process is the
 * only thing still alive in that state: the containers die before they can
 * alert, and an in-container watchdog only runs when a container boots.
 *
 * Also warns once when the workspaces disk runs low, because a full disk is
 * what caused both observed outages (2026-10-02, 27h; 2026-10-04, 10.6h).
 */

export interface SessionOutcome {
	status: "success" | "error";
	error?: string | undefined;
}

export interface SpawnHealthOptions {
	notify: (text: string) => Promise<void>;
	/** Free bytes on the disk the containers write to, or null if unknown. */
	freeBytes?: () => number | null;
	threshold?: number;
	lowDiskBytes?: number;
	now?: () => number;
}

const GB = 1024 ** 3;

export class SpawnHealthMonitor {
	private failStreak = 0;
	private streakStart = 0;
	private alerted = false;
	private lowDiskAlerted = false;
	private readonly threshold: number;
	private readonly lowDiskBytes: number;
	private readonly now: () => number;

	constructor(private readonly opts: SpawnHealthOptions) {
		this.threshold = opts.threshold ?? 5;
		this.lowDiskBytes = opts.lowDiskBytes ?? 3 * GB;
		this.now = opts.now ?? Date.now;
	}

	/** Returns the alert text it sent, if any (for tests and logs). */
	async record(outcome: SessionOutcome): Promise<string | null> {
		const messages: string[] = [];
		const free = this.opts.freeBytes?.() ?? null;

		if (free !== null) {
			if (!this.lowDiskAlerted && free < this.lowDiskBytes) {
				this.lowDiskAlerted = true;
				messages.push(
					`⚠️ PicoClaw: only ${fmtGb(free)} free on the workspaces disk. At 0, every session fails.`,
				);
			} else if (free >= this.lowDiskBytes * 2) {
				this.lowDiskAlerted = false;
			}
		}

		if (outcome.status === "error") {
			if (this.failStreak === 0) this.streakStart = this.now();
			this.failStreak++;
			if (!this.alerted && this.failStreak >= this.threshold) {
				this.alerted = true;
				const since = new Date(this.streakStart).toISOString().slice(0, 16);
				const disk = free === null ? "" : ` Free disk: ${fmtGb(free)}.`;
				messages.push(
					`🔴 PicoClaw: the last ${this.failStreak} sessions all failed (since ${since}Z). Last error: ${truncate(outcome.error ?? "unknown", 200)}.${disk}`,
				);
			}
		} else {
			if (this.alerted) {
				const hours = (this.now() - this.streakStart) / 3_600_000;
				messages.push(
					`✅ PicoClaw: sessions work again after ${this.failStreak} failures (${hours.toFixed(1)}h).`,
				);
			}
			this.failStreak = 0;
			this.alerted = false;
		}

		if (messages.length === 0) return null;
		const text = messages.join("\n");
		try {
			await this.opts.notify(text);
		} catch {
			// The alert path must never break the spawn path.
		}
		return text;
	}
}

export function freeBytesAt(dir: string): number | null {
	try {
		const s = fs.statfsSync(dir);
		return s.bavail * s.bsize;
	} catch {
		return null;
	}
}

function fmtGb(bytes: number): string {
	return `${(bytes / GB).toFixed(1)} GB`;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

let monitor: SpawnHealthMonitor | null = null;

export function configureSpawnHealth(opts: SpawnHealthOptions): void {
	monitor = new SpawnHealthMonitor(opts);
}

export function recordSessionOutcome(outcome: SessionOutcome): void {
	void monitor?.record(outcome);
}
