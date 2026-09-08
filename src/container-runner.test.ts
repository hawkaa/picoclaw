import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OPENROUTER_PROVIDER, type ProviderConfig } from "./config.ts";
import { PROVIDER_THINKING_BUDGETS, readSecrets } from "./container-runner.ts";
import type { EffortLevel } from "./types.ts";

/**
 * readSecrets assembles the env-secret block a container is spawned with.
 * These tests pin the effort→MAX_THINKING_TOKENS mapping (provider-routed
 * models only — Claude models keep the SDK's native adaptive effort) and the
 * pre-existing auth-style invariants.
 */

const API_KEY_PROVIDER: ProviderConfig = {
	baseUrl: "https://api.example.test/anthropic",
	apiKeyEnvVar: "PICOCLAW_TEST_PROVIDER_KEY",
	authStyle: "api-key",
};

// Every env var these tests read or mutate, snapshotted around each test so
// the suite neither depends on nor pollutes the host environment.
const TOUCHED_ENV_KEYS = [
	OPENROUTER_PROVIDER.apiKeyEnvVar,
	API_KEY_PROVIDER.apiKeyEnvVar,
	"ANTHROPIC_MODEL",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of TOUCHED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of TOUCHED_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("readSecrets effort → MAX_THINKING_TOKENS", () => {
	const efforts = Object.keys(PROVIDER_THINKING_BUDGETS) as EffortLevel[];

	for (const effort of efforts) {
		test(`provider + effort "${effort}" maps to the ${effort} thinking budget`, () => {
			process.env[OPENROUTER_PROVIDER.apiKeyEnvVar] = "or-key";

			const secrets = readSecrets(
				"sk-ant-unused",
				"vendor/model",
				OPENROUTER_PROVIDER,
				effort,
			);

			expect(secrets["MAX_THINKING_TOKENS"]).toBe(
				String(PROVIDER_THINKING_BUDGETS[effort]),
			);
		});
	}

	test("provider without effort emits no MAX_THINKING_TOKENS", () => {
		process.env[OPENROUTER_PROVIDER.apiKeyEnvVar] = "or-key";

		const secrets = readSecrets(
			"sk-ant-unused",
			"vendor/model",
			OPENROUTER_PROVIDER,
			undefined,
		);

		expect(secrets).not.toHaveProperty("MAX_THINKING_TOKENS");
	});

	test("effort without a provider never leaks MAX_THINKING_TOKENS (Claude keeps adaptive effort)", () => {
		const secrets = readSecrets(
			"sk-ant-plain-key",
			undefined,
			undefined,
			"high",
		);

		expect(secrets).not.toHaveProperty("MAX_THINKING_TOKENS");
	});
});

describe("readSecrets provider auth styles", () => {
	test("auth-token style routes the key via ANTHROPIC_AUTH_TOKEN and blanks ANTHROPIC_API_KEY", () => {
		process.env[OPENROUTER_PROVIDER.apiKeyEnvVar] = "or-secret-token";

		const secrets = readSecrets(
			"sk-ant-unused",
			"vendor/model",
			OPENROUTER_PROVIDER,
		);

		expect(secrets["ANTHROPIC_AUTH_TOKEN"]).toBe("or-secret-token");
		expect(secrets["ANTHROPIC_API_KEY"]).toBe("");
		expect(secrets["ANTHROPIC_BASE_URL"]).toBe(OPENROUTER_PROVIDER.baseUrl);
	});

	test("api-key style routes the key via ANTHROPIC_API_KEY with no auth token", () => {
		process.env[API_KEY_PROVIDER.apiKeyEnvVar] = "provider-secret";

		const secrets = readSecrets(
			"sk-ant-unused",
			"some-model",
			API_KEY_PROVIDER,
		);

		expect(secrets["ANTHROPIC_API_KEY"]).toBe("provider-secret");
		expect(secrets).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
		expect(secrets["ANTHROPIC_BASE_URL"]).toBe(API_KEY_PROVIDER.baseUrl);
	});

	test("missing provider key throws naming the env var", () => {
		// beforeEach already deleted OPENROUTER_API_KEY from the environment.
		expect(() =>
			readSecrets("sk-ant-unused", "vendor/model", OPENROUTER_PROVIDER, "low"),
		).toThrow(OPENROUTER_PROVIDER.apiKeyEnvVar);
	});
});
