/**
 * Child process for runner.test.ts. Runs the real runDurable() against pi-ai's
 * faux provider. argv: <phase: crash|resume> <root dir> [sessionId]
 */
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { runDurable } from "./runner.ts";

const [phase, root, sessionId] = process.argv.slice(2) as [
	string,
	string,
	string | undefined,
];
const workspace = path.join(root, "ws");
const marker = path.join(workspace, "marker.txt");

const faux = fauxProvider({ provider: "faux", models: [{ id: "f1" }] });
faux.setResponses(
	phase === "crash"
		? [
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: `sleep 3; echo late > ${marker}` })],
					{ stopReason: "toolUse" },
				),
			]
		: [
				// 1st request: the run the crashed container left behind.
				(c) => {
					const last = c.messages.at(-1);
					const seen =
						last?.role === "toolResult" && last.isError
							? "interrupted-tool-seen"
							: `unexpected:${JSON.stringify(last).slice(0, 120)}`;
					return fauxAssistantMessage(`recovered ${seen}`);
				},
				// 2nd request: this container's own prompt.
				fauxAssistantMessage("answered new prompt"),
			],
);
const models = createModels();
models.setProvider(faux.provider);

const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({
	cwd: workspace,
	agentDir: path.join(root, "agent"),
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noContextFiles: true,
	noPromptTemplates: true,
	noThemes: true,
});
await resourceLoader.reload();

if (phase === "crash") {
	// SIGKILL mid-tool: no cleanup, no close, like an OOM or a dead host.
	setTimeout(() => process.kill(process.pid, "SIGKILL"), 1500);
}
await runDurable({
	prompt: phase === "crash" ? "do the slow thing" : "new prompt",
	sessionId,
	modelSpec: "faux/f1",
	apiKey: "unused",
	systemPrompt: "test",
	resourceLoader,
	workspace,
	agentDir: path.join(root, "agent"),
	models,
	ipcInputDir: path.join(root, "ipc"),
});
