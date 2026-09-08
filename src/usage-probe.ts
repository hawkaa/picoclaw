/**
 * Subscription usage probe + limit-event log.
 *
 * Containers run with a fresh /home/bun/.claude that is NOT logged in, so a
 * session cannot see how much of the host's Claude subscription it has burned
 * (`claude usage` inside a container prints "Not logged in"). The OAuth
 * credentials live only on the host. This module runs host-side, reads those
 * credentials, and queries the same endpoint the Claude Code `/usage` UI uses,
 * then drops a small JSON snapshot into each chat's container-visible /ipc so a
 * session can read /ipc/usage-status.json and pace itself.
 *
 * Endpoint + auth were extracted from the installed Claude Code binary (not
 * guessed): `GET {BASE_API_URL}/api/oauth/usage` with an
 * `Authorization: Bearer <accessToken>` and `anthropic-beta: oauth-2025-04-20`
 * header. The response carries per-window objects
 * `{ utilization: 0..1, resets_at: <unix seconds> }` for `five_hour` and
 * `seven_day` (the CLI renders them as `utilization * 100` and
 * `new Date(resets_at * 1000)`). We normalize both the 0..1 `utilization` shape
 * and a 0..100 `used_percentage` shape defensively.
 *
 * It also records "ran out of limits" events: when a spawn/session fails with a
 * rate-limit / usage-exhausted error, a line is appended to
 * /ipc/limit-events.jsonl so sessions can register and learn from them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";

import { DATA_DIR, WORKSPACES_DIR } from "./config.ts";

const log = pino({ name: "usage-probe" });

/** Refresh cadence. Spec requires <= 15 min; 10 min leaves headroom. */
export const USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** Beta header the Claude Code CLI sends on OAuth calls (from the binary). */
const USAGE_BETA_HEADER = "oauth-2025-04-20";
const USAGE_PATH = "/api/oauth/usage";
const FETCH_TIMEOUT_MS = 5000;

/** One rate-limit window as returned by /api/oauth/usage. */
export interface UsageWindow {
	/** 0..1 fraction of the window consumed (endpoint + header shape). */
	utilization?: number | null;
	/** 0..100 percentage (alternate/statusline shape). */
	used_percentage?: number | null;
	/** Unix seconds (endpoint shape) or ISO string. */
	resets_at?: number | string | null;
}

/** Subset of the /api/oauth/usage body we consume; unknown fields ignored. */
export interface RawUsageResponse {
	five_hour?: UsageWindow | null;
	seven_day?: UsageWindow | null;
}

/** Container-visible snapshot written to /ipc/usage-status.json. */
export interface UsageSnapshot {
	/** false when the probe could not read a fresh value (see `error`). */
	ok: boolean;
	probed_at: string;
	/** 5-hour session budget consumed, 0..100 (null when unknown). */
	five_hour_utilization_pct: number | null;
	/** Weekly budget consumed, 0..100 (null when unknown). */
	weekly_utilization_pct: number | null;
	/** When the 5-hour session budget refills (ISO), null when unknown. */
	resets_at: string | null;
	/** When the weekly budget refills (ISO), null when unknown. */
	weekly_resets_at: string | null;
	/** Reason the probe failed, when `ok` is false; null otherwise. */
	error: string | null;
}

/** A recorded "ran out of limits" event. */
export interface LimitEvent {
	ts: string;
	chatId: string;
	label: string | null;
	error_class: string;
	detail?: string;
}

// --- Pure helpers (unit-tested) ---

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function pctFromWindow(w: UsageWindow | null | undefined): number | null {
	if (!w) return null;
	if (typeof w.used_percentage === "number") return round1(w.used_percentage);
	if (typeof w.utilization === "number") return round1(w.utilization * 100);
	return null;
}

function isoFromResets(v: number | string | null | undefined): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "string") {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d.toISOString();
	}
	// The endpoint returns unix SECONDS; guard against a millisecond value.
	const ms = v < 1e12 ? v * 1000 : v;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Normalize a raw /api/oauth/usage body into a snapshot. */
export function normalizeUsage(
	raw: RawUsageResponse,
	probedAt: Date = new Date(),
): UsageSnapshot {
	const five = raw.five_hour ?? null;
	const week = raw.seven_day ?? null;
	return {
		ok: true,
		probed_at: probedAt.toISOString(),
		five_hour_utilization_pct: pctFromWindow(five),
		weekly_utilization_pct: pctFromWindow(week),
		resets_at: isoFromResets(five?.resets_at),
		weekly_resets_at: isoFromResets(week?.resets_at),
		error: null,
	};
}

/**
 * A snapshot for when the probe could not read usage. We deliberately leave the
 * pct fields null rather than 0 — a stale/failed read must not look like "0%
 * used, plenty of budget".
 */
export function failureSnapshot(
	error: string,
	probedAt: Date = new Date(),
): UsageSnapshot {
	return {
		ok: false,
		probed_at: probedAt.toISOString(),
		five_hour_utilization_pct: null,
		weekly_utilization_pct: null,
		resets_at: null,
		weekly_resets_at: null,
		error,
	};
}

/** Classify an error string as a usage/rate limit, or null if it is neither. */
export function classifyLimitError(text: string): string | null {
	const t = text.toLowerCase();
	if (
		/usage limit reached|usage_limit|monthly limit|quota (?:exceeded|reached)|exceeded your [^.]*usage/.test(
			t,
		)
	) {
		return "usage_limit_reached";
	}
	// 429 only counts as an HTTP status, not any stray "429" (e.g. a byte count).
	if (
		/rate.?limit|too many requests|(?:status(?:\s+code)?|http|error)\s+429\b|\b429\s+too many/.test(
			t,
		)
	) {
		return "rate_limit";
	}
	return null;
}

/** Build a LimitEvent record (pure; io is done by appendLimitEvent). */
export function formatLimitEvent(input: {
	chatId: string;
	errorClass: string;
	label?: string | null | undefined;
	detail?: string | undefined;
	ts?: Date | undefined;
}): LimitEvent {
	const ev: LimitEvent = {
		ts: (input.ts ?? new Date()).toISOString(),
		chatId: input.chatId,
		label: input.label ?? null,
		error_class: input.errorClass,
	};
	if (input.detail) ev.detail = input.detail.slice(0, 300);
	return ev;
}

// --- IO helpers ---

/** Write JSON via temp-then-rename so a reader never sees a half-written file. */
export function writeJsonFile(filePath: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
	fs.renameSync(tmp, filePath);
}

/** Append one JSON object as a line to a .jsonl file. */
export function appendJsonl(filePath: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

// --- Credentials + fetch ---

interface OAuthCreds {
	accessToken: string;
	expiresAt?: number | undefined;
}

function claudeConfigDir(): string {
	return process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
}

export function credentialsPath(): string {
	return path.join(claudeConfigDir(), ".credentials.json");
}

/** Read the host's Claude OAuth credentials, or null if absent/unreadable. */
export function readOAuthCreds(): OAuthCreds | null {
	let raw: string;
	try {
		raw = fs.readFileSync(credentialsPath(), "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as {
			claudeAiOauth?: { accessToken?: string; expiresAt?: number };
		};
		const oauth = parsed.claudeAiOauth;
		if (!oauth?.accessToken) return null;
		return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
	} catch {
		return null;
	}
}

export function usageEndpoint(): string {
	const base = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com";
	return `${base.replace(/\/+$/, "")}${USAGE_PATH}`;
}

async function fetchUsage(accessToken: string): Promise<RawUsageResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(usageEndpoint(), {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				"anthropic-beta": USAGE_BETA_HEADER,
				"User-Agent": "picoclaw-usage-probe/1.0",
				Authorization: `Bearer ${accessToken}`,
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as RawUsageResponse;
	} finally {
		clearTimeout(timer);
	}
}

// --- Orchestration ---

export function canonicalSnapshotPath(): string {
	return path.join(DATA_DIR, "usage-status.json");
}

export function canonicalLimitEventsPath(): string {
	return path.join(DATA_DIR, "limit-events.jsonl");
}

function chatIpcDir(chatId: string): string {
	return path.join(WORKSPACES_DIR, chatId, "ipc");
}

/** Copy the snapshot into every existing chat's container-visible /ipc dir. */
function fanOutSnapshot(snapshot: UsageSnapshot): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const ipcDir = chatIpcDir(entry.name);
		if (!fs.existsSync(ipcDir)) continue;
		try {
			writeJsonFile(path.join(ipcDir, "usage-status.json"), snapshot);
		} catch (err) {
			log.warn({ err, chatId: entry.name }, "Failed fan-out of usage snapshot");
		}
	}
}

/**
 * Fetch usage and publish a fresh snapshot to the canonical path and every
 * chat's /ipc. Always resolves (failures are captured in the snapshot).
 */
export async function refreshUsageSnapshot(): Promise<UsageSnapshot> {
	let snapshot: UsageSnapshot;
	const creds = readOAuthCreds();
	if (!creds) {
		snapshot = failureSnapshot(
			`no OAuth credentials at ${credentialsPath()} (host CLI not logged in?)`,
		);
	} else if (creds.expiresAt !== undefined && creds.expiresAt <= Date.now()) {
		snapshot = failureSnapshot(
			"OAuth access token expired — host CLI refreshes it on next interactive use",
		);
	} else {
		try {
			snapshot = normalizeUsage(await fetchUsage(creds.accessToken));
		} catch (err) {
			snapshot = failureSnapshot(
				`usage fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	try {
		writeJsonFile(canonicalSnapshotPath(), snapshot);
	} catch (err) {
		log.warn({ err }, "Failed to write canonical usage snapshot");
	}
	fanOutSnapshot(snapshot);
	if (!snapshot.ok) log.warn({ error: snapshot.error }, "Usage probe: no data");
	return snapshot;
}

/**
 * Publish the latest canonical snapshot into one chat's /ipc. Called at spawn
 * so a brand-new chat, or a spawn between refresh ticks, still sees data.
 * No-ops silently if the probe has not produced a snapshot yet.
 */
export function writeUsageSnapshotToChat(chatId: string): void {
	let snapshot: string;
	try {
		snapshot = fs.readFileSync(canonicalSnapshotPath(), "utf-8");
	} catch {
		return;
	}
	const ipcDir = chatIpcDir(chatId);
	try {
		fs.mkdirSync(ipcDir, { recursive: true });
		fs.writeFileSync(path.join(ipcDir, "usage-status.json"), snapshot);
	} catch (err) {
		log.warn({ err, chatId }, "Failed to write usage snapshot on spawn");
	}
}

/** Record a "ran out of limits" event to the canonical log and the chat's /ipc. */
export function appendLimitEvent(input: {
	chatId: string;
	errorClass: string;
	label?: string | null | undefined;
	detail?: string | undefined;
}): LimitEvent {
	const ev = formatLimitEvent(input);
	try {
		appendJsonl(canonicalLimitEventsPath(), ev);
	} catch (err) {
		log.warn({ err }, "Failed to append canonical limit event");
	}
	try {
		appendJsonl(path.join(chatIpcDir(input.chatId), "limit-events.jsonl"), ev);
	} catch (err) {
		log.warn(
			{ err, chatId: input.chatId },
			"Failed to append chat limit event",
		);
	}
	log.warn(
		{ chatId: ev.chatId, label: ev.label, errorClass: ev.error_class },
		"Limit event recorded",
	);
	return ev;
}

/** Start the periodic probe. Returns the interval handle (unref'd). */
export function startUsageProbe(): ReturnType<typeof setInterval> {
	void refreshUsageSnapshot().catch((err) =>
		log.warn({ err }, "Initial usage probe failed"),
	);
	const handle = setInterval(() => {
		void refreshUsageSnapshot().catch((err) =>
			log.warn({ err }, "Usage probe refresh failed"),
		);
	}, USAGE_REFRESH_INTERVAL_MS);
	handle.unref?.();
	return handle;
}
