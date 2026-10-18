/**
 * EXPERIMENTAL Pi Durable runner (opt-in: PICOCLAW_RUNNER=durable, via
 * secrets or profile.extraEnv). Same stdin/stdout/IPC protocol as the default
 * runner in ../index.ts; the difference is underneath.
 *
 * Each session is one SQLite file (<agentDir>/durable/<sessionId>.sqlite)
 * holding the root conversation. Every model turn and tool call is committed
 * before it is shown, so a container killed mid-run (OOM, ENOSPC, host
 * restart) leaves the run pending. The next container that resumes the same
 * sessionId calls `harness.resume()`, which finishes it: a tool call that was
 * running comes back to the model as an "interrupted" error result.
 *
 * Known gaps vs the default runner (on purpose, to keep the spike small):
 * - tools are pi-durable's read/write/edit/bash; no grep/find/ls tools
 * - models must be in pi-ai's catalog (no resolvePiModel sibling-clone)
 * - default-runner .jsonl sessions are not migrated; durable ids are new
 */

import fs from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ImageContent,
	InMemoryCredentialStore,
	type ModelThinkingLevel,
	type MutableModels,
	type TextContent,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type DefaultResourceLoader,
	formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentEvent,
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	type ModelRef,
	section,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openBunSqliteStorage } from "./bun-sqlite.ts";

type EffortLevel = "low" | "medium" | "high" | "max" | "xhigh";

interface ImageAttachment {
	data: string;
	mediaType: string;
}

export interface DurableRunInput {
	prompt: string;
	sessionId?: string | undefined;
	isScheduledTask?: boolean | undefined;
	images?: ImageAttachment[] | undefined;
	effort?: EffortLevel | undefined;
	modelSpec: string;
	apiKey: string;
	systemPrompt: string;
	resourceLoader: DefaultResourceLoader;
	workspace: string;
	agentDir: string;
	/** Test seams: a model catalog (e.g. pi-ai's faux provider) and the IPC dir. */
	models?: MutableModels | undefined;
	ipcInputDir?: string | undefined;
}

interface ContainerOutput {
	status: "success" | "error";
	result: string | null;
	newSessionId?: string | undefined;
	error?: string | undefined;
	type?: "text" | "result" | "tool_use" | undefined;
	toolName?: string | undefined;
}

type Content = string | (TextContent | ImageContent)[];

let IPC_INPUT_DIR = "/ipc/input";
const IPC_POLL_MS = 500;
const ctx: Context = BACKGROUND_CONTEXT;

function writeOutput(output: ContainerOutput): void {
	console.log("---PICOCLAW_OUTPUT_START---");
	console.log(JSON.stringify(output));
	console.log("---PICOCLAW_OUTPUT_END---");
}

function log(message: string): void {
	console.error(`[agent-runner:durable] ${message}`);
}

function toContent(text: string, images?: ImageAttachment[]): Content {
	if (!images || images.length === 0) return text;
	return [
		{ type: "text", text },
		...images.map(
			(img): ImageContent => ({
				type: "image",
				data: img.data,
				mimeType: img.mediaType,
			}),
		),
	];
}

function shouldClose(): boolean {
	const close = path.join(IPC_INPUT_DIR, "_close");
	if (!fs.existsSync(close)) return false;
	try {
		fs.unlinkSync(close);
	} catch {}
	return true;
}

type IpcEvent =
	| { kind: "message"; content: Content }
	| { kind: "switch"; model?: string; apiKey?: string; effort?: EffortLevel };

function drainIpc(): IpcEvent[] {
	fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
	const events: IpcEvent[] = [];
	for (const file of fs
		.readdirSync(IPC_INPUT_DIR)
		.filter((f) => f.endsWith(".json"))
		.sort()) {
		const p = path.join(IPC_INPUT_DIR, file);
		try {
			const d = JSON.parse(fs.readFileSync(p, "utf8"));
			fs.unlinkSync(p);
			if (d.type === "switch") {
				events.push({
					kind: "switch",
					model: d.model,
					apiKey: d.apiKey,
					effort: d.effort,
				});
			} else if (d.type === "message") {
				const text = d.from
					? `[${d.from.name} via ${d.from.source}] ${d.text ?? ""}`
					: (d.text ?? "");
				events.push({ kind: "message", content: toContent(text, d.images) });
			}
		} catch (err) {
			log(`Bad IPC file ${file}: ${String(err)}`);
			try {
				fs.unlinkSync(p);
			} catch {}
		}
	}
	return events;
}

function modelRef(spec: string): ModelRef {
	const slash = spec.indexOf("/");
	if (slash < 1)
		throw new Error(`PICOCLAW_MODEL must be provider/model, got "${spec}"`);
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** The "max" effort the host knows is pi-ai's "xhigh". */
function thinking(effort: EffortLevel): ModelThinkingLevel {
	return effort === "max" ? "xhigh" : effort;
}

export async function runDurable(input: DurableRunInput): Promise<void> {
	if (input.ipcInputDir) IPC_INPUT_DIR = input.ipcInputDir;
	const credentials = new InMemoryCredentialStore();
	const models = input.models ?? builtinModels({ credentials });
	const setKey = async (provider: string, key: string) => {
		await credentials.modify(provider, async () => ({ type: "api_key", key }));
	};
	const resolve = (spec: string): ModelRef => {
		const ref = modelRef(spec);
		if (!models.getModel(ref.provider, ref.modelId)) {
			throw new Error(`Model ${spec} is not in pi-ai's catalog`);
		}
		return ref;
	};

	let model = resolve(input.modelSpec);
	await setKey(model.provider, input.apiKey);

	// Same system prompt the default runner sends, as durable sections. Sections
	// are diffed per request, so an unchanged prompt is never re-sent.
	const loader = input.resourceLoader;
	const contextFiles = loader.getAgentsFiles().agentsFiles;
	const skills = loader.getSkills().skills;
	const picoclaw = defineExtension({
		name: "picoclaw",
		sections: [
			section("preamble", () => input.systemPrompt, { tag: false }),
			section("project_context", () =>
				contextFiles.length === 0
					? undefined
					: contextFiles
							.map(
								(f) =>
									`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`,
							)
							.join("\n\n"),
			),
			section("skills", () =>
				skills.length === 0
					? undefined
					: formatSkillsForPrompt(skills, "read").trim() || undefined,
			),
			section("cwd", () => input.workspace),
		],
	});
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(picoclaw);

	const priorId = input.sessionId;
	const dir = path.join(input.agentDir, "durable");
	const priorFile = priorId ? path.join(dir, `${priorId}.sqlite`) : undefined;
	const resuming = priorFile !== undefined && fs.existsSync(priorFile);
	if (priorId && !resuming) log(`Session ${priorId} not found, starting fresh`);
	const sessionId = resuming && priorId ? priorId : crypto.randomUUID();

	const harness = await Harness.open(
		await openBunSqliteStorage(path.join(dir, `${sessionId}.sqlite`)),
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? input.workspace }),
		},
		ctx,
	);
	const root: Conversation = await harness.root(ctx, {
		agent: { model, cwd: input.workspace },
	});
	await root.configure(
		{
			model,
			...(input.effort ? { thinkingLevel: thinking(input.effort) } : {}),
		},
		ctx,
	);
	log(`Session ${resuming ? "resumed" : "created"}: ${sessionId}`);

	let runError: string | null = null;
	const events = await watchEvents(harness, root.id, ctx);
	events.start(async (batch: readonly AgentEvent[]) => {
		for (const ev of batch) {
			if (ev.type === "tool_execution_start") {
				writeOutput({
					status: "success",
					result: null,
					type: "tool_use",
					toolName: ev.toolName,
				});
			}
			if (ev.type !== "message_end" || ev.entry.kind !== "pi.assistant") {
				continue;
			}
			for (const msg of ev.entry.model ?? []) {
				if (msg.role !== "assistant") continue;
				if (msg.stopReason === "error") {
					runError = msg.errorMessage ?? "assistant turn failed";
				}
				const text = msg.content
					.filter((b): b is TextContent => b.type === "text")
					.map((b) => b.text)
					.filter((t) => t.trim().length > 0)
					.join("\n");
				if (text)
					writeOutput({ status: "success", result: text, type: "text" });
			}
		}
	});

	// A run the last container left unfinished continues now; its output
	// streams through the watcher above like any other run.
	harness.resume();

	const applySwitch = async (ev: Extract<IpcEvent, { kind: "switch" }>) => {
		try {
			if (ev.model && ev.apiKey) {
				model = resolve(ev.model);
				await setKey(model.provider, ev.apiKey);
				await root.configure({ model }, ctx);
				log(`Switched model to ${ev.model}`);
			}
			if (ev.effort) {
				await root.configure({ thinkingLevel: thinking(ev.effort) }, ctx);
				log(`Switched effort to ${ev.effort}`);
			}
		} catch (err) {
			writeOutput({
				status: "success",
				result: `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
				type: "text",
			});
		}
	};

	/** Submit, steer with IPC arrivals, wait. Returns true if _close arrived. */
	const runOnce = async (content: Content): Promise<boolean> => {
		runError = null;
		const submission = await root.submit({ type: "input", content }, ctx);
		let closed = false;
		let polling = true;
		const poll = async () => {
			if (!polling) return;
			if (shouldClose()) {
				closed = true;
				polling = false;
				await root.abort(ctx);
				return;
			}
			for (const ev of drainIpc()) {
				if (ev.kind === "switch") await applySwitch(ev);
				else {
					log("Steering active run with IPC message");
					await root.submit(
						{ type: "input", content: ev.content, whenBusy: "steer" },
						ctx,
					);
				}
			}
			setTimeout(poll, IPC_POLL_MS);
		};
		setTimeout(poll, IPC_POLL_MS);
		const settled = await submission.wait(ctx);
		polling = false;
		if (settled.status !== "done" && !closed) {
			runError ??= `input unanswered: ${JSON.stringify(settled).slice(0, 300)}`;
		}
		if (runError) throw new Error(runError);
		writeOutput({
			status: "success",
			result: null,
			newSessionId: sessionId,
			type: "result",
		});
		return closed;
	};

	try {
		let text = input.isScheduledTask
			? `[SCHEDULED TASK]\n\n${input.prompt}`
			: input.prompt;
		const pendingSwitches: Extract<IpcEvent, { kind: "switch" }>[] = [];
		for (const ev of drainIpc()) {
			if (ev.kind === "message" && typeof ev.content === "string")
				text += `\n${ev.content}`;
			else if (ev.kind === "switch") pendingSwitches.push(ev);
		}
		for (const ev of pendingSwitches) await applySwitch(ev);
		let content: Content = toContent(text, input.images);

		while (true) {
			if (await runOnce(content)) break;
			log("Run ended, waiting for next IPC message...");
			const next = await new Promise<Content | null>((done) => {
				const tick = async () => {
					if (shouldClose()) return done(null);
					const texts: string[] = [];
					const images: ImageContent[] = [];
					for (const ev of drainIpc()) {
						if (ev.kind === "switch") await applySwitch(ev);
						else if (typeof ev.content === "string") texts.push(ev.content);
						else
							for (const b of ev.content) {
								if (b.type === "text") texts.push(b.text);
								else images.push(b);
							}
					}
					if (texts.length > 0 || images.length > 0) {
						const joined = texts.join("\n");
						return done(
							images.length > 0
								? [{ type: "text", text: joined }, ...images]
								: joined,
						);
					}
					setTimeout(tick, IPC_POLL_MS);
				};
				void tick();
			});
			if (next === null) break;
			content = next;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`Agent error: ${message}`);
		writeOutput({
			status: "error",
			result: null,
			newSessionId: sessionId,
			error: message,
		});
		await events.stop();
		await harness.close(ctx);
		process.exit(1);
	}
	await events.stop();
	await harness.close(ctx);
}
