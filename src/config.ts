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
 * Non-Anthropic providers exposing an Anthropic-compatible API. The Claude
 * Agent SDK is pointed at them purely via environment variables, so the
 * harness (system prompt, CLAUDE.md, skills, hooks, IPC) is identical across
 * providers.
 */
export interface ProviderConfig {
	/** Anthropic-compatible endpoint, injected as ANTHROPIC_BASE_URL. */
	baseUrl: string;
	/** Host env var holding the provider API key (never stored in bots.json). */
	apiKeyEnvVar: string;
	/**
	 * Credential source for providers whose key is not a static env var — e.g. a
	 * short-lived OAuth token a vendor CLI maintains on disk. When present it
	 * wins over `apiKeyEnvVar`; null means "not configured on this host", which
	 * raises the same missing-key error as an unset env var.
	 */
	resolveKey?: (() => string | null) | undefined;
	/**
	 * How the endpoint authenticates:
	 * - "api-key": key goes in ANTHROPIC_API_KEY (Moonshot style)
	 * - "auth-token": key goes in ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY
	 *   must be explicitly empty (OpenRouter style)
	 */
	authStyle: "api-key" | "auth-token";
}

export interface ModelTarget {
	model: string;
	provider?: ProviderConfig | undefined;
}

/**
 * OpenRouter's Anthropic-compatible "skin". Any OpenRouter model id works
 * through it — nothing is hardcoded per model.
 * (https://openrouter.ai/docs — ANTHROPIC_AUTH_TOKEN + empty ANTHROPIC_API_KEY)
 */
export const OPENROUTER_PROVIDER: ProviderConfig = {
	baseUrl: "https://openrouter.ai/api",
	apiKeyEnvVar: "OPENROUTER_API_KEY",
	authStyle: "auth-token",
};

/**
 * xAI's Anthropic-compatible Messages API, authenticated with the OAuth token
 * the official `grok` CLI mints and refreshes on this host (see xai-oauth.ts).
 * That routes frontier work onto a flat-price Grok subscription instead of
 * per-token billing. Inert until an operator runs `grok login --device-auth`.
 *
 * Measured 2026-09-08: POST https://api.x.ai/v1/messages with
 * `Authorization: Bearer <oauth>` returns 200 for grok-4.6. The same request
 * with `x-api-key` returns 400, hence auth-token style.
 */
export const XAI_PROVIDER: ProviderConfig = {
	baseUrl: "https://api.x.ai",
	apiKeyEnvVar: "XAI_API_KEY",
	// The token is minted once, at spawn, and never re-read — so it has to
	// outlive the longest a container can run. CONTAINER_TIMEOUT is that bound.
	resolveKey: () => resolveXaiAccessToken(CONTAINER_TIMEOUT),
	authStyle: "auth-token",
};

export const MODEL_ALIASES: Record<string, string | ModelTarget> = {
	fable: "claude-fable-5",
	opus: "claude-opus-5",
	"opus-5": "claude-opus-5",
	"opus-4.8": "claude-opus-4-8",
	"opus-4.7": "claude-opus-4-7",
	"opus-4.6": "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5-20251001",
	// Kimi K3 via Moonshot's own Anthropic-compatible endpoint
	// (https://platform.kimi.ai/docs/guide/claude-code-kimi)
	k3: {
		model: "kimi-k3",
		provider: {
			baseUrl: "https://api.moonshot.ai/anthropic",
			apiKeyEnvVar: "MOONSHOT_API_KEY",
			authStyle: "api-key",
		},
	},
	// Convenience shorthand; the slash form routes via OpenRouter (see below)
	kimi: "moonshotai/kimi-k3",
	// Grok on the host's own subscription. These ids carry no slash, so they
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
