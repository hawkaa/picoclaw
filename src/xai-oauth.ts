/**
 * xAI (Grok) auth backed by the official `grok` CLI login on the host.
 *
 * PicoClaw never runs an OAuth flow and never presents a client_id it was not
 * issued. The access token is minted AND refreshed by xAI's own binary
 * (`grok login --device-auth`, then `grok models` to rotate). We only read
 * `~/.grok/auth.json`. Absent that file this module returns null and the
 * provider is inert — a fresh server needs only the grok CLI, not omp/oh-my-pi.
 *
 * Operator setup (once, on the host):
 *   curl -fsSL https://x.ai/cli/install.sh | bash
 *   grok login --device-auth
 */

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

function readCredential(): XaiCredential | null {
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
 * A fresh xAI access token, or null when the host has no `grok` login.
 * Null is the inert path: the provider then behaves as if unconfigured.
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
	const cred = readCredential();
	if (cred && isFresh(cred, now, minLifetimeMs)) return cred.accessToken;
	refreshViaOfficialCli();
	const after = readCredential();
	if (!after) return null;
	return after.accessToken;
}

type XaiProbeFetch = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean }>;

/** Cheap liveness check. 2xx from /v1/models means the bearer will survive spawn. */
export async function probeXaiAccessToken(
	token: string,
	fetchImpl: XaiProbeFetch = fetch,
): Promise<boolean> {
	try {
		const res = await fetchImpl("https://api.x.ai/v1/models", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Token that has been probed live, or null. Expiry in auth.json can lie
 * (revoked refresh). On probe failure, ask the grok CLI to rotate and probe
 * again so a container never starts with a 403 waiting on the first turn.
 */
export async function ensureXaiAccessToken(
	minLifetimeMs: number,
	fetchImpl: XaiProbeFetch = fetch,
): Promise<string | null> {
	const first = resolveXaiAccessToken(minLifetimeMs);
	if (first && (await probeXaiAccessToken(first, fetchImpl))) return first;
	refreshViaOfficialCli();
	const after = readCredential()?.accessToken ?? null;
	if (after && (await probeXaiAccessToken(after, fetchImpl))) return after;
	return after ?? first;
}
