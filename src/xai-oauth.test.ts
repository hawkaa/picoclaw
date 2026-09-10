import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CONTAINER_TIMEOUT,
	resolveModelTarget,
	XAI_PROVIDER,
} from "./config.ts";
import {
	API_KEY_SECRET,
	MODEL_SECRET,
	readSecrets,
} from "./container-runner.ts";
import {
	parseOmpXaiCredential,
	parseXaiAuth,
	resolveXaiAccessToken,
} from "./xai-oauth.ts";

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

describe("parseOmpXaiCredential", () => {
	test("reads access + epoch-ms expiry from omp's sqlite blob", () => {
		const parsed = parseOmpXaiCredential(
			JSON.stringify({
				access: "header.payload.signature",
				refresh: "opaque",
				expires: 1789038477920,
				accountId: "bc8bd46f",
				email: "hakon@aamdal.com",
			}),
		);
		expect(parsed?.accessToken).toBe("header.payload.signature");
		expect(parsed?.expiresAt).toBe(1789038477920);
	});

	test("returns null on malformed JSON rather than throwing", () => {
		expect(parseOmpXaiCredential("{not json")).toBeNull();
	});

	test("rejects a token containing control characters", () => {
		expect(
			parseOmpXaiCredential(JSON.stringify({ access: "abc\ndef", expires: 1 })),
		).toBeNull();
	});
});

describe("xAI model routing", () => {
	test("bare grok aliases route to xAI, not to Anthropic", () => {
		// These ids carry no slash, so without an explicit target inferProvider
		// would silently treat them as Anthropic model names.
		for (const alias of ["grok", "grok-4.6", "grok-4.5"]) {
			expect(resolveModelTarget(alias).provider?.id).toBe("xai");
		}
	});

	test("grok resolves to the current default model", () => {
		expect(resolveModelTarget("grok").model).toBe("grok-4.6");
	});

	test("the slash form still routes via OpenRouter", () => {
		// Regression: adding first-party xAI must not capture the generic
		// vendor/model path that already worked.
		expect(resolveModelTarget("x-ai/grok-4.6").provider?.id).toBe("openrouter");
	});
});

describe("readSecrets with a credential-minting provider", () => {
	const withResolver = (resolveKey: () => string | null) => ({
		...XAI_PROVIDER,
		resolveKey,
	});

	test("hands the minted token to the runner as the xai credential", () => {
		const secrets = readSecrets(
			"sk-ant-unused",
			"grok-4.6",
			withResolver(() => "minted-token"),
		);
		expect(secrets[MODEL_SECRET]).toBe("xai/grok-4.6");
		expect(secrets[API_KEY_SECRET]).toBe("minted-token");
	});

	test("falls back to the env var when no token is on disk", () => {
		process.env["XAI_API_KEY"] = "env-fallback-key";
		try {
			const secrets = readSecrets(
				"sk-ant-unused",
				"grok-4.6",
				withResolver(() => null),
			);
			expect(secrets[API_KEY_SECRET]).toBe("env-fallback-key");
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
			),
		).toThrow(/grok login --device-auth/);
	});
});

/**
 * The token is resolved ONCE, at container spawn, and never re-read. So the
 * only question that matters is not "is it valid now" but "will it still be
 * valid when this container hits its hard timeout". These tests drive the real
 * refresh seam — a stub binary on $GROK_BIN standing in for xAI's CLI — rather
 * than mocking the module, because the seam is a process spawn and a file
 * rewrite, which is exactly where it breaks.
 */
describe("resolveXaiAccessToken lifetime margin", () => {
	const MIN = 60 * 1000;

	function withStubbedGrokHome(
		expiresInMs: number,
		run: (dir: string, ranMarker: string) => void,
	): void {
		const dir = mkdtempSync(join(tmpdir(), "grok-home-"));
		const ranMarker = join(dir, "refresh-ran");
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
					key: "stale-token",
					expires_at: new Date(Date.now() + expiresInMs).toISOString(),
				},
			}),
		);
		// Stands in for `grok models`: touches a marker so the test can see it
		// ran, then rewrites auth.json the way the real CLI does.
		const stub = join(dir, "grok-stub.sh");
		writeFileSync(
			stub,
			`#!/bin/sh\ntouch "${ranMarker}"\ncat > "${authPath}" <<'EOF'\n${JSON.stringify(
				{
					"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
						key: "refreshed-token",
						expires_at: new Date(Date.now() + 6 * 60 * MIN).toISOString(),
					},
				},
			)}\nEOF\n`,
		);
		chmodSync(stub, 0o755);
		const prevHome = process.env["GROK_HOME"];
		const prevBin = process.env["GROK_BIN"];
		const prevOmp = process.env["OMP_AGENT_DIR"];
		process.env["GROK_HOME"] = dir;
		process.env["GROK_BIN"] = stub;
		// Don't let a live omp login on the test host short-circuit the CLI path.
		process.env["OMP_AGENT_DIR"] = join(dir, "no-omp");
		try {
			run(dir, ranMarker);
		} finally {
			if (prevHome === undefined) delete process.env["GROK_HOME"];
			else process.env["GROK_HOME"] = prevHome;
			if (prevBin === undefined) delete process.env["GROK_BIN"];
			else process.env["GROK_BIN"] = prevBin;
			if (prevOmp === undefined) delete process.env["OMP_AGENT_DIR"];
			else process.env["OMP_AGENT_DIR"] = prevOmp;
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("refreshes a token that would expire before the container times out", () => {
		// 45 min of life, 60 min container: valid right now, dead at minute 45.
		withStubbedGrokHome(45 * MIN, (_dir, ranMarker) => {
			const token = resolveXaiAccessToken(60 * MIN);
			expect(existsSync(ranMarker)).toBe(true);
			expect(token).toBe("refreshed-token");
		});
	});

	test("leaves a token alone when it outlives the required window", () => {
		withStubbedGrokHome(45 * MIN, (_dir, ranMarker) => {
			const token = resolveXaiAccessToken(30 * MIN);
			expect(existsSync(ranMarker)).toBe(false);
			expect(token).toBe("stale-token");
		});
	});

	test("uses $GROK_BIN, since the installer leaves grok off a service PATH", () => {
		withStubbedGrokHome(1 * MIN, (dir, _ranMarker) => {
			resolveXaiAccessToken(60 * MIN);
			// Proof the stub ran, not merely that the spawn failed silently.
			expect(readFileSync(join(dir, "auth.json"), "utf8")).toContain(
				"refreshed-token",
			);
		});
	});

	test("the provider asks for at least a full container lifetime", () => {
		// The wiring, not the module: config.ts must pass the container bound.
		withStubbedGrokHome(CONTAINER_TIMEOUT - 5 * MIN, (_dir, ranMarker) => {
			XAI_PROVIDER.resolveKey?.();
			expect(existsSync(ranMarker)).toBe(true);
		});
	});
});
