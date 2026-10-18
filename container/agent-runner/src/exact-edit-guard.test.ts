/**
 * Runs the real pi edit tool through a faux-provider session with the guard
 * loaded the way index.ts loads it (extensionFactories), and checks the file
 * on disk: an exact edit lands; an oldText with "-" where the file has an
 * en dash is blocked and the file is byte-identical.
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
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { exactEditGuard, inexactEdits } from "./exact-edit-guard.ts";
import { resolvePiModel } from "./resolve-pi-model.ts";

const ORIGINAL =
	"Rule one \u2013 keep \u201Cquotes\u201D curly.\nSecond line, untouched\u00A0here.\n";

async function runEdit(edits: { oldText: string; newText: string }[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "exact-edit-"));
	const workspace = path.join(root, "ws");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(workspace);
	fs.mkdirSync(agentDir);
	const file = path.join(workspace, "doc.md");
	fs.writeFileSync(file, ORIGINAL);

	let toolResult: { isError: boolean; text: string } | undefined;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "f1" }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("edit", { path: "doc.md", edits })], {
			stopReason: "toolUse",
		}),
		(c) => {
			const last = c.messages.at(-1);
			if (last?.role === "toolResult") {
				toolResult = {
					isError: last.isError,
					text: last.content
						.map((b) => (b.type === "text" ? b.text : ""))
						.join(""),
				};
			}
			return fauxAssistantMessage("done");
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
			{ name: "picoclaw-exact-edit", factory: exactEditGuard(workspace) },
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
		tools: ["read", "edit"],
	});
	await session.prompt("edit it", { expandPromptTemplates: false });
	session.dispose();
	return { after: fs.readFileSync(file, "utf8"), toolResult };
}

test("exact oldText: edit lands, other bytes untouched", async () => {
	const { after, toolResult } = await runEdit([
		{ oldText: "Rule one \u2013 keep", newText: "Rule 1 \u2013 keep" },
	]);
	expect(toolResult?.isError).toBe(false);
	expect(after).toBe(ORIGINAL.replace("Rule one", "Rule 1"));
}, 30_000);

test("hyphen where the file has an en dash: blocked, file byte-identical", async () => {
	const { after, toolResult } = await runEdit([
		{ oldText: "Rule one - keep", newText: "Rule 1 - keep" },
	]);
	expect(toolResult?.isError).toBe(true);
	expect(toolResult?.text).toContain("not an exact substring");
	expect(after).toBe(ORIGINAL);
}, 30_000);

test("one fuzzy edit in a multi-edit call blocks the whole call", async () => {
	const { after, toolResult } = await runEdit([
		{ oldText: "Rule one \u2013 keep", newText: "Rule 1 \u2013 keep" },
		{ oldText: "untouched here", newText: "changed here" },
	]);
	expect(toolResult?.isError).toBe(true);
	expect(toolResult?.text).toContain("edits[1]");
	expect(after).toBe(ORIGINAL);
}, 30_000);

test("inexactEdits: CRLF file and BOM match like pi matches", () => {
	expect(inexactEdits("\uFEFFa\r\nb", ["a\nb"])).toEqual([]);
	expect(inexactEdits("a \u2014 b", ["a - b", "a \u2014 b"])).toEqual([0]);
});
