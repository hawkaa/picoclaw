import { describe, expect, test } from "bun:test";

import { resolveModelTarget, XAI_PROVIDER } from "./config.ts";
import { readSecrets } from "./container-runner.ts";
import { parseXaiAuth } from "./xai-oauth.ts";

/**
 * Grok on a flat-price subscription instead of per-token billing. The
 * credential is a short-lived OAuth token that xAI's own `grok` CLI mints and
 * refreshes on the host; PicoClaw only reads it. These tests pin the parse
 * (which must fail closed) and the wiring (which must stay inert on a host
 * that never logged in).
 *
 * Shape of a real ~/.grok/auth.json, verified against a live file 2026-09-08.
 */
const SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

function authFile(entry: Record<string, unknown>): string {
	return JSON.stringify({ [SCOPE]: entry });
}

describe("parseXaiAuth", () => {
	test("reads the access token and expiry from a real-shaped file", () => {
		const parsed = parseXaiAuth(
			authFile({
				key: "header.payload.signature",
				expires_at: "2026-09-08T14:27:37.911645561Z",
				auth_mode: "oidc",
			}),
		);
		expect(parsed?.accessToken).toBe("header.payload.signature");
		expect(parsed?.expiresAt).toBe(Date.parse("2026-09-08T14:27:37.911Z"));
	});

	test("returns null on malformed JSON rather than throwing", () => {
		expect(parseXaiAuth("{not json")).toBeNull();
	});

	test("ignores credentials from a non-xAI issuer", () => {
		// A customer-SSO (OIDC) login writes its own issuer into the same file.
		// Picking that up would send an unrelated IdP's token to api.x.ai.
		const foreign = JSON.stringify({
			"https://acme.okta.com::0oa1b2c3": { key: "not-ours", expires_at: null },
		});
		expect(parseXaiAuth(foreign)).toBeNull();
	});

	test("rejects a token containing control characters", () => {
		// A newline in a bearer would corrupt/split the Authorization header.
		expect(parseXaiAuth(authFile({ key: "abc\ndef" }))).toBeNull();
	});

	test("rejects an empty or non-string token", () => {
		expect(parseXaiAuth(authFile({ key: "" }))).toBeNull();
		expect(parseXaiAuth(authFile({ key: 42 }))).toBeNull();
	});

	test("tolerates a missing expiry instead of discarding the token", () => {
		const parsed = parseXaiAuth(authFile({ key: "tok" }));
		expect(parsed?.accessToken).toBe("tok");
		expect(parsed?.expiresAt).toBeNull();
	});
});

describe("xAI model routing", () => {
	test("bare grok aliases route to xAI, not to Anthropic", () => {
		// These ids carry no slash, so without an explicit target inferProvider
		// would silently treat them as Anthropic model names.
		for (const alias of ["grok", "grok-4.6", "grok-4.5"]) {
			expect(resolveModelTarget(alias).provider?.baseUrl).toBe(
				"https://api.x.ai",
			);
		}
	});

	test("grok resolves to the current default model", () => {
		expect(resolveModelTarget("grok").model).toBe("grok-4.6");
	});

	test("the slash form still routes via OpenRouter", () => {
		// Regression: adding first-party xAI must not capture the generic
		// vendor/model path that already worked.
		expect(resolveModelTarget("x-ai/grok-4.6").provider?.baseUrl).toBe(
			"https://openrouter.ai/api",
		);
	});
});

describe("readSecrets with a credential-minting provider", () => {
	const withResolver = (resolveKey: () => string | null) => ({
		...XAI_PROVIDER,
		resolveKey,
	});

	test("uses the minted token as a bearer and blanks ANTHROPIC_API_KEY", () => {
		const secrets = readSecrets(
			"sk-ant-unused",
			"grok-4.6",
			withResolver(() => "minted-token"),
			undefined,
		);
		expect(secrets["ANTHROPIC_BASE_URL"]).toBe("https://api.x.ai");
		expect(secrets["ANTHROPIC_AUTH_TOKEN"]).toBe("minted-token");
		// xAI answered 400 to x-api-key, so the SDK must not fall back to it.
		expect(secrets["ANTHROPIC_API_KEY"]).toBe("");
	});

	test("falls back to the env var when no token is on disk", () => {
		process.env["XAI_API_KEY"] = "env-fallback-key";
		try {
			const secrets = readSecrets(
				"sk-ant-unused",
				"grok-4.6",
				withResolver(() => null),
				undefined,
			);
			expect(secrets["ANTHROPIC_AUTH_TOKEN"]).toBe("env-fallback-key");
		} finally {
			delete process.env["XAI_API_KEY"];
		}
	});

	test("stays inert on a host with neither login nor env var", () => {
		delete process.env["XAI_API_KEY"];
		// Merging this must change nothing until an operator opts in, and the
		// error must say how to opt in.
		expect(() =>
			readSecrets(
				"sk-ant-unused",
				"grok-4.6",
				withResolver(() => null),
				undefined,
			),
		).toThrow(/grok login --device-auth/);
	});
});
