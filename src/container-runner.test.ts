import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MOONSHOT_PROVIDER, OPENROUTER_PROVIDER } from "./config.ts";
import {
	API_KEY_SECRET,
	MODEL_SECRET,
	readSecrets,
} from "./container-runner.ts";

/**
 * readSecrets is the whole host→runner contract: a `provider/model` spec and
 * the single credential that provider needs. Nothing else may leak through.
 */

const TOUCHED_ENV_KEYS = [
	OPENROUTER_PROVIDER.apiKeyEnvVar,
	MOONSHOT_PROVIDER.apiKeyEnvVar,
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
		const v = savedEnv[key];
		if (v === undefined) delete process.env[key];
		else process.env[key] = v;
	}
});

describe("readSecrets", () => {
	test("Anthropic models carry the bot's own credential", () => {
		expect(readSecrets("sk-ant-oat01-token", "claude-opus-5")).toEqual({
			[MODEL_SECRET]: "anthropic/claude-opus-5",
			[API_KEY_SECRET]: "sk-ant-oat01-token",
		});
	});

	test("provider-routed models use the host env credential, never the bot key", () => {
		process.env[OPENROUTER_PROVIDER.apiKeyEnvVar] = "or-key";
		expect(
			readSecrets(
				"sk-ant-unused",
				"deepseek/deepseek-chat",
				OPENROUTER_PROVIDER,
			),
		).toEqual({
			[MODEL_SECRET]: "openrouter/deepseek/deepseek-chat",
			[API_KEY_SECRET]: "or-key",
		});
	});

	test("a missing provider credential fails at spawn, naming the env var", () => {
		expect(() =>
			readSecrets("sk-ant-unused", "kimi-k3", MOONSHOT_PROVIDER),
		).toThrow(/MOONSHOT_API_KEY/);
	});
});
