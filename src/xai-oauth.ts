/**
 * xAI (Grok) auth: reuse the SuperGrok OAuth token this host's omp install
 * already maintains (`~/.omp/agent/agent.db`, provider `xai-oauth`).
 *
 * Same account, same client, same bearer this omp session is using right now.
 * PicoClaw never runs an OAuth flow and never touches the refresh token —
 * omp owns refresh. Fallback: the official `grok` CLI's auth.json, for hosts
 * that logged in with `grok login` but not omp.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** xAI's production OAuth issuer; grok CLI auth.json keys are `{issuer}::{client_id}`. */
const XAI_ISSUER = "https://auth.x.ai";

/** `$GROK_HOME` (verbatim when non-empty) else `~/.grok`, matching the CLI. */
export function grokHome(): string {
	const override = process.env["GROK_HOME"];
	return override && override.length > 0 ? override : join(homedir(), ".grok");
}

/**
 * The `grok` binary. xAI's installer drops it in `~/.grok/downloads/` and only
 * links it onto an *interactive* PATH, so a service-managed host (systemd's
 * minimal PATH) can have a perfectly good login and still fail to refresh it.
 * `$GROK_BIN` is the escape hatch; bare `grok` stays the default.
 */
function grokBin(): string {
	const override = process.env["GROK_BIN"];
	return override && override.length > 0 ? override : "grok";
}

export function xaiAuthPath(): string {
	return join(grokHome(), "auth.json");
}

export function ompAuthDbPath(): string {
	const override = process.env["OMP_AGENT_DIR"];
	const agentDir =
		override && override.length > 0
			? override
			: join(homedir(), ".omp", "agent");
	return join(agentDir, "agent.db");
}

export interface XaiCredential {
	accessToken: string;
	/** Epoch ms, or null when the file carries no parsable expiry. */
	expiresAt: number | null;
}

function asBearer(
	token: unknown,
	expiresAt: number | null,
): XaiCredential | null {
	if (typeof token !== "string" || token.length === 0) return null;
	// A bearer must be a single line; a control char would corrupt the header.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
	if (/[\u0000-\u001f\u007f]/.test(token)) return null;
	return { accessToken: token, expiresAt };
}

/**
 * Parse a `grok` auth.json. Exported so tests can drive it without a real file.
 * Returns null for anything malformed — a bad parse must never put garbage on
 * the wire, it must fall back to the normal per-token path.
 */
export function parseXaiAuth(raw: string): XaiCredential | null {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof doc !== "object" || doc === null) return null;
	for (const [scope, value] of Object.entries(doc as Record<string, unknown>)) {
		if (!scope.startsWith(`${XAI_ISSUER}::`)) continue;
		if (typeof value !== "object" || value === null) continue;
		const entry = value as Record<string, unknown>;
		const rawExpiry = entry["expires_at"];
		let expiresAt: number | null = null;
		if (typeof rawExpiry === "string") {
			const parsed = Date.parse(rawExpiry);
			if (!Number.isNaN(parsed)) expiresAt = parsed;
		}
		const cred = asBearer(entry["key"], expiresAt);
		if (cred) return cred;
	}
	return null;
}

/**
 * Parse one `auth_credentials.data` blob from omp's sqlite store
 * (`provider = xai-oauth`, `credential_type = oauth`).
 */
export function parseOmpXaiCredential(raw: string): XaiCredential | null {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof doc !== "object" || doc === null) return null;
	const entry = doc as Record<string, unknown>;
	const rawExpiry = entry["expires"];
	let expiresAt: number | null = null;
	if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
		expiresAt = rawExpiry;
	}
	return asBearer(entry["access"], expiresAt);
}

function readOmpCredential(): XaiCredential | null {
	const path = ompAuthDbPath();
	if (!existsSync(path)) return null;
	try {
		const db = new Database(path, { readonly: true });
		try {
			const row = db
				.query(
					"select data from auth_credentials where provider = 'xai-oauth' and credential_type = 'oauth' limit 1",
				)
				.get() as { data: string } | null;
			if (!row || typeof row.data !== "string") return null;
			return parseOmpXaiCredential(row.data);
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

function readGrokCliCredential(): XaiCredential | null {
	const path = xaiAuthPath();
	if (!existsSync(path)) return null;
	try {
		return parseXaiAuth(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function isFresh(
	cred: XaiCredential,
	now: number,
	minLifetimeMs: number,
): boolean {
	// No expiry recorded: trust it rather than hammering the CLI every call.
	if (cred.expiresAt === null) return true;
	return cred.expiresAt - now > minLifetimeMs;
}

/**
 * Ask xAI's own CLI to refresh. `grok models` is the cheapest command that
 * boots the auth manager; it rewrites auth.json as a side effect. Measured
 * 2026-09-08: with an expired token seeded, this rotated the stored token and
 * the rotated token then returned HTTP 200 from api.x.ai — even though the
 * command's own stdout still reported the pre-refresh state, so its output is
 * deliberately ignored and the FILE is re-read instead.
 */
function refreshViaOfficialCli(): void {
	try {
		spawnSync(grokBin(), ["models"], {
			timeout: 60_000,
			stdio: "ignore",
			env: process.env,
		});
	} catch {
		// Binary absent or failed: fall through and use whatever is on disk.
	}
}

/**
 * A fresh xAI access token, or null when this host has no SuperGrok login.
 * Prefers omp's live `xai-oauth` credential (omp owns that refresh token).
 * grok CLI is fallback only.
 *
 * `minLifetimeMs` is required, not defaulted, because the only safe value is a
 * property of the CALLER, not of this module: the token is resolved once at
 * container spawn and then never re-read, so it must outlive the container it
 * is handed to. A margin shorter than the container's hard timeout hands out a
 * credential that expires mid-run and 401s a session that had already started.
 */
export function resolveXaiAccessToken(
	minLifetimeMs: number,
	now: number = Date.now(),
): string | null {
	const omp = readOmpCredential();
	if (omp) return omp.accessToken;

	const cred = readGrokCliCredential();
	if (cred && isFresh(cred, now, minLifetimeMs)) return cred.accessToken;
	refreshViaOfficialCli();
	const after = readGrokCliCredential();
	if (!after) return null;
	return after.accessToken;
}
