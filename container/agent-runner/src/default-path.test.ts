/**
 * The pi 1.0 -> 1.3 bump touches the DEFAULT runner too. index.ts calls main()
 * on import and hard-codes /workspace, so this test cannot run main() itself.
 * It runs the same pi-coding-agent calls main() makes, in the same order:
 * ModelRuntime.create -> resolvePiModel -> setRuntimeApiKey ->
 * DefaultResourceLoader (bash via extensionFactories) -> createAgentSession
 * (TOOLS) -> session.prompt, with pi-ai's faux provider in place of a real one.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createBashTool,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./resolve-pi-model.ts";

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

test("default runner: one turn with one bash tool call on pi 1.3", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "default-"));
	const workspace = path.join(root, "ws");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(workspace);
	fs.mkdirSync(agentDir);
	const marker = path.join(workspace, "marker.txt");

	const faux = fauxProvider({ provider: "faux", models: [{ id: "f1" }] });
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("bash", { command: `echo ran > ${marker}` })],
			{ stopReason: "toolUse" },
		),
		(c) => {
			const last = c.messages.at(-1);
			return fauxAssistantMessage(
				last?.role === "toolResult" && !last.isError
					? "tool result seen"
					: `unexpected:${JSON.stringify(last).slice(0, 120)}`,
			);
		},
	]);

	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const model = resolvePiModel("faux/f1", (p, id) =>
		modelRuntime.getModel(p, id),
	);
	await modelRuntime.setRuntimeApiKey(model.provider, "unused");

	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		systemPromptOverride: () => "test",
		extensionFactories: [
			{
				name: "picoclaw-bash",
				factory: (pi: ExtensionAPI) =>
					pi.registerTool(createBashTool(workspace)),
			},
		],
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: workspace,
		agentDir,
		model,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.create(workspace, undefined, undefined),
		tools: TOOLS,
	});
	const texts: string[] = [];
	const toolStarts: string[] = [];
	session.subscribe((e) => {
		if (e.type === "tool_execution_start") toolStarts.push(e.toolName);
		if (e.type === "message_end" && e.message.role === "assistant") {
			for (const b of e.message.content)
				if (b.type === "text" && b.text.trim()) texts.push(b.text);
		}
	});
	await session.prompt("do it", { expandPromptTemplates: false });
	session.dispose();

	expect(toolStarts).toEqual(["bash"]);
	expect(texts).toEqual(["tool result seen"]);
	expect(fs.readFileSync(marker, "utf8").trim()).toBe("ran");
}, 30_000);
