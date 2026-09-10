import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BotConfig, EffortLevel } from "./types.ts";
import { resolveXaiAccessToken } from "./xai-oauth.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const WORKSPACES_DIR = path.join(PROJECT_ROOT, "workspaces");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const CONTAINER_DIR = path.join(PROJECT_ROOT, "container");
export const SEEDS_DIR = path.join(CONTAINER_DIR, "seeds");
/** Host-owned executables a scheduled task may name as its `precondition`. */
export const PRECONDITIONS_DIR = path.join(PROJECT_ROOT, "preconditions");

export const CONTAINER_BASE_IMAGE = "picoclaw-base:latest";
export const CONTAINER_TIMEOUT = 60 * 60 * 1000; // 60 min hard timeout
export const IDLE_TIMEOUT = 60 * 60 * 1000; // 60 min idle → close
export const IPC_POLL_INTERVAL = 1000; // 1s
export const TASK_CHECK_INTERVAL = 60 * 1000; // 60s
// A precondition runs on the host, in front of a container that costs ~30K
// tokens to boot. It must be cheap; this bound is a backstop, not a budget.
export const PRECONDITION_TIMEOUT = 30 * 1000; // 30s
export const TELEGRAM_POLL_TIMEOUT = 30; // seconds

/**
 * A pi provider the runner can route to. The runner resolves
 * `provider/model-id` against pi's model catalog and hands it the credential
 * directly, so every backend shares one harness (system prompt, CLAUDE.md,
 * skills, IPC). Provider ids are pi's: https://github.com/earendil-works/pi
 */
export interface ProviderConfig {
	/** pi provider id (`anthropic`, `openrouter`, `moonshotai`, `xai`). */
	id: string;
	/** Host env var holding the provider API key (never stored in bots.json). */
	apiKeyEnvVar: string;
	/**
	 * Credential source for providers whose key is not a static env var — e.g. a
	 * short-lived OAuth token a vendor CLI maintains on disk. When present it
	 * wins over `apiKeyEnvVar`; null means "not configured on this host", which
	 * raises the same missing-key error as an unset env var.
	 */
	resolveKey?: (() => string | null) | undefined;
}

export interface ModelTarget {
	model: string;
	/** Omitted → Anthropic, authenticated with the bot's own key/OAuth token. */
	provider?: ProviderConfig | undefined;
}

/** Any `vendor/model` id routes through OpenRouter generically. */
export const OPENROUTER_PROVIDER: ProviderConfig = {
	id: "openrouter",
	apiKeyEnvVar: "OPENROUTER_API_KEY",
};

export const MOONSHOT_PROVIDER: ProviderConfig = {
	id: "moonshotai",
	apiKeyEnvVar: "MOONSHOT_API_KEY",
};

/**
 * xAI via SuperGrok OAuth (`grok login` on the host). Inert until an
 * operator has logged in. PicoClaw only reads ~/.grok/auth.json.
 */
export const XAI_PROVIDER: ProviderConfig = {
	id: "xai",
	apiKeyEnvVar: "XAI_API_KEY",
	// The token is minted once, at spawn, and never re-read — so it has to
	// outlive the longest a container can run. CONTAINER_TIMEOUT is that bound.
	resolveKey: () => resolveXaiAccessToken(CONTAINER_TIMEOUT),
};

/** Used when neither the session, the bot, nor ANTHROPIC_MODEL names a model. */
export const DEFAULT_MODEL = "claude-opus-5";

export const MODEL_ALIASES: Record<string, string | ModelTarget> = {
	fable: "claude-fable-5",
	opus: "claude-opus-5",
	"opus-5": "claude-opus-5",
	"opus-4.8": "claude-opus-4-8",
	"opus-4.7": "claude-opus-4-7",
	"opus-4.6": "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5-20251001",
	// Kimi K3 direct from Moonshot
	k3: { model: "kimi-k3", provider: MOONSHOT_PROVIDER },
	// Convenience shorthand; the slash form routes via OpenRouter (see below)
	kimi: "moonshotai/kimi-k3",
	// Grok on the host's own xAI login. These ids carry no slash, so they
	// need explicit targets — inferProvider would otherwise read them as
	// Anthropic model names. `x-ai/grok-4.6` still routes via OpenRouter.
	grok: { model: "grok-4.6", provider: XAI_PROVIDER },
	"grok-4.6": { model: "grok-4.6", provider: XAI_PROVIDER },
	"grok-4.5": { model: "grok-4.5", provider: XAI_PROVIDER },
};

/**
 * OpenRouter model ids are always "vendor/model"; Anthropic ids never contain
 * a slash. Any slash-form id therefore routes via OpenRouter generically —
 * `/new deepseek/deepseek-chat` works without touching this file.
 */
function inferProvider(model: string): ModelTarget {
	return model.includes("/")
		? { model, provider: OPENROUTER_PROVIDER }
		: { model };
}

export function resolveModelTarget(alias: string): ModelTarget {
	const entry = MODEL_ALIASES[alias.toLowerCase()];
	if (entry === undefined) return inferProvider(alias);
	return typeof entry === "string" ? inferProvider(entry) : entry;
}

export function resolveModelId(alias: string): string {
	return resolveModelTarget(alias).model;
}

const VALID_EFFORT_LEVELS = new Set<EffortLevel>([
	"low",
	"medium",
	"high",
	"max",
	"xhigh",
]);

export function parseEffortLevel(value: string): EffortLevel | null {
	const lower = value.toLowerCase() as EffortLevel;
	return VALID_EFFORT_LEVELS.has(lower) ? lower : null;
}

export function loadBotConfigs(): BotConfig[] {
	const botsFile = path.join(PROJECT_ROOT, "bots.json");
	if (!fs.existsSync(botsFile)) {
		throw new Error(`bots.json not found at ${botsFile}`);
	}
	const raw = JSON.parse(fs.readFileSync(botsFile, "utf-8"));
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("bots.json must be a non-empty array");
	}
	// Migration: accept anthropicModel as fallback for defaultModel
	for (const entry of raw) {
		if (!entry.defaultModel && entry.anthropicModel) {
			entry.defaultModel = entry.anthropicModel;
			delete entry.anthropicModel;
		}
		if (!entry.anthropicApiKey) {
			throw new Error(
				`Bot "${entry.name}" is missing required "anthropicApiKey" in bots.json`,
			);
		}
	}
	return raw as BotConfig[];
}

export const OUTPUT_START_MARKER = "---PICOCLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---PICOCLAW_OUTPUT_END---";

export const SYSTEM_PROMPT = `You are an autonomous agent operating in a persistent Debian container with bash and curl.
/workspace persists between sessions. /workspace/CLAUDE.md is loaded into your context every session — keep it concise.
If /workspace/Dockerfile.extra exists, it extends your container image (cached, rebuilt only on change).
If /workspace/start.sh exists, it runs before you start.
To send a message while still working, write a JSON file to /ipc/messages/.`;
