import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BotConfig } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const WORKSPACES_DIR = path.join(PROJECT_ROOT, "workspaces");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const CONTAINER_DIR = path.join(PROJECT_ROOT, "container");
export const SEEDS_DIR = path.join(CONTAINER_DIR, "seeds");

export const CONTAINER_BASE_IMAGE = "picoclaw-base:latest";
export const CONTAINER_TIMEOUT = 30 * 60 * 1000; // 30 min hard timeout
export const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 min idle → close
export const IPC_POLL_INTERVAL = 1000; // 1s
export const TASK_CHECK_INTERVAL = 60 * 1000; // 60s
export const TELEGRAM_POLL_TIMEOUT = 30; // seconds

export function loadBotConfigs(): BotConfig[] {
	const botsFile = path.join(PROJECT_ROOT, "bots.json");
	if (!fs.existsSync(botsFile)) {
		throw new Error(`bots.json not found at ${botsFile}`);
	}
	const raw = JSON.parse(fs.readFileSync(botsFile, "utf-8"));
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("bots.json must be a non-empty array");
	}
	return raw as BotConfig[];
}

export const OUTPUT_START_MARKER = "---PICOCLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---PICOCLAW_OUTPUT_END---";

export const SYSTEM_PROMPT = `You are a personal assistant running in a Debian container with bash and curl.
/workspace persists between sessions. /workspace/CLAUDE.md is loaded into your context every session — keep it concise.
If /workspace/Dockerfile.extra exists, it extends your container image (cached, rebuilt only on change).
If /workspace/start.sh exists, it runs before you start.
To send a message while still working, write a JSON file to /ipc/messages/.`;
