/**
 * xAI (Grok) auth backed by a *subscription* instead of per-token billing.
 *
 * Why this exists: frontier calls are the single largest variable cost in the
 * fleet. A SuperGrok subscription is flat-price, and xAI serves an
 * Anthropic-compatible Messages API at https://api.x.ai/v1/messages — the same
 * shape PicoClaw already speaks to OpenRouter and Moonshot. So the subscription
 * can carry frontier work through the existing ProviderConfig seam, unchanged.
 *
 * CREDENTIAL OWNERSHIP — the important part.
 * xAI ships an official device-code OAuth flow inside its own `grok` CLI,
 * documented for exactly this case ("headless or remote environments"). The
 * access token is minted AND refreshed by that binary, under xAI's own
 * client_id. PicoClaw never runs an OAuth flow, never presents a client_id it
 * was not issued, and never touches the refresh_token itself: when the token is
 * near expiry it *invokes the official binary* and re-reads what that binary
 * wrote. We are a reader of a credential xAI's own client maintains.
 *
 * Operator setup (once, on the host):
 *   curl -fsSL https://x.ai/cli/install.sh | bash
 *   grok login --device-auth      # approve on any browser; account holder only
 *
 * Absent that file this module returns null and the provider is inert, so
 * merging this changes nothing until an operator opts in by logging in.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** xAI's production OAuth issuer; auth.json keys are `{issuer}::{client_id}`. */
const XAI_ISSUER = "https://auth.x.ai";

/**
 * Refresh when the token has less than this left. The CLI mints ~6h tokens, and
 * a container can outlive its own start, so refresh early rather than mid-run.
 */
const REFRESH_MARGIN_MS = 30 * 60 * 1000; // 30 min

/** `$GROK_HOME` (verbatim when non-empty) else `~/.grok`, matching the CLI. */
export function grokHome(): string {
	const override = process.env["GROK_HOME"];
	return override && override.length > 0 ? override : join(homedir(), ".grok");
}

export function xaiAuthPath(): string {
	return join(grokHome(), "auth.json");
}

export interface XaiCredential {
	accessToken: string;
	/** Epoch ms, or null when the file carries no parsable expiry. */
	expiresAt: number | null;
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
		const key = entry["key"];
		if (typeof key !== "string" || key.length === 0) continue;
		// A bearer must be a single line; a control char would corrupt the header.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
		if (/[\u0000-\u001f\u007f]/.test(key)) continue;
		const rawExpiry = entry["expires_at"];
		let expiresAt: number | null = null;
		if (typeof rawExpiry === "string") {
			const parsed = Date.parse(rawExpiry);
			if (!Number.isNaN(parsed)) expiresAt = parsed;
		}
		return { accessToken: key, expiresAt };
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

function isFresh(cred: XaiCredential, now: number): boolean {
	// No expiry recorded: trust it rather than hammering the CLI every call.
	if (cred.expiresAt === null) return true;
	return cred.expiresAt - now > REFRESH_MARGIN_MS;
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
		spawnSync("grok", ["models"], {
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
 */
export function resolveXaiAccessToken(now: number = Date.now()): string | null {
	const cred = readCredential();
	if (cred && isFresh(cred, now)) return cred.accessToken;
	refreshViaOfficialCli();
	const after = readCredential();
	if (!after) return null;
	// Return even if still stale: a 401 from xAI is a clearer operator signal
	// than a silent fallback to per-token billing they did not ask for.
	return after.accessToken;
}
