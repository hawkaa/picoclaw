import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi's edit tool falls back to fuzzy matching when an oldText is not found
// verbatim. On a fuzzy hit it rewrites every line any edit in the call touches
// from a normalized copy (NFKC, en/em dash -> "-", curly -> straight quotes,
// NBSP -> space, trailing whitespace stripped) and still reports success.
// In files where one line is a whole paragraph, that silently rewrites the
// paragraph. This guard blocks the call instead, so the model re-reads and
// copies the exact text.

type RawEdit = { oldText?: unknown };

function collectOldTexts(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	let edits = input["edits"];
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	if (edits && !Array.isArray(edits) && typeof edits === "object")
		edits = [edits];
	if (Array.isArray(edits)) {
		for (const e of edits as RawEdit[]) {
			if (e && typeof e.oldText === "string") out.push(e.oldText);
		}
	}
	if (typeof input["oldText"] === "string")
		out.push(input["oldText"] as string);
	return out;
}

const toLF = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** Indexes of oldTexts that are not an exact substring of the file (after BOM strip + LF, as pi does). */
export function inexactEdits(
	fileContent: string,
	oldTexts: string[],
): number[] {
	const content = toLF(fileContent.replace(/^\uFEFF/, ""));
	const bad: number[] = [];
	oldTexts.forEach((t, i) => {
		const needle = toLF(t);
		if (needle.length > 0 && !content.includes(needle)) bad.push(i);
	});
	return bad;
}

export function exactEditGuard(cwd: string) {
	return (pi: ExtensionAPI): void => {
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "edit") return undefined;
			const input = event.input as unknown as Record<string, unknown>;
			const rawPath = input["path"];
			if (typeof rawPath !== "string") return undefined;
			const p = path.resolve(cwd, rawPath.replace(/^@/, ""));
			let content: string;
			try {
				content = fs.readFileSync(p, "utf-8");
			} catch {
				return undefined; // let the edit tool report the missing file
			}
			const bad = inexactEdits(content, collectOldTexts(input));
			if (bad.length === 0) return undefined;
			return {
				block: true,
				reason: `edits[${bad.join(",")}].oldText is not an exact substring of ${rawPath}. The edit tool would fuzzy-match and rewrite every touched line from a normalized copy (dashes, quotes, NBSP, NFKC). Re-read the file and copy the exact text.`,
			};
		});
	};
}
