import { describe, expect, test } from "bun:test";
import {
	applyCompatShim,
	fillRequiredArrays,
	foldNonStandardRoles,
	normalizeRequest,
	startCompatShim,
} from "./compat-shim.ts";

/**
 * The two request shapes below are what Claude Code 2.1.258 actually put on the
 * wire (captured through a logging proxy, 2026-09-08) and what xAI rejected.
 * Each was then isolated against https://api.x.ai/v1/messages on its own:
 *   role:"system" alone            -> 400 "Invalid message role."
 *   object schema with no required -> 400 "/required: null is not of type array"
 *   both normalized                -> 200
 * The live tests at the bottom re-run exactly that, through the shipped shim.
 */
const XAI = "https://api.x.ai";

/**
 * CronList's real input_schema: an object schema with no `required` key.
 * A factory, not a constant — normalizeRequest mutates what it is handed, and a
 * shared literal let an earlier test poison the live test's fixture into
 * passing.
 */
const cronListSchema = () => ({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	additionalProperties: false,
	properties: {},
	type: "object",
});

describe("fillRequiredArrays", () => {
	test("adds an empty required to an object schema that has none", () => {
		const schema = cronListSchema();
		fillRequiredArrays(schema);
		expect(schema).toHaveProperty("required", []);
	});

	test("leaves an existing required list alone", () => {
		const schema = { type: "object", required: ["a"], properties: {} };
		fillRequiredArrays(schema);
		expect(schema.required).toEqual(["a"]);
	});

	test("reaches nested object schemas (TaskCreate fails on one)", () => {
		const schema = {
			type: "object",
			required: ["description"],
			properties: {
				description: { type: "string" },
				metadata: { type: "object", properties: { k: { type: "string" } } },
			},
		};
		fillRequiredArrays(schema);
		expect(schema.properties.metadata).toHaveProperty("required", []);
	});

	test("does not invent required on non-object schemas", () => {
		const schema = { type: "array", items: { type: "string" } };
		fillRequiredArrays(schema);
		expect(schema).not.toHaveProperty("required");
		expect(schema.items).not.toHaveProperty("required");
	});
});

describe("foldNonStandardRoles", () => {
	test("folds a system message into the user turn before it, in order", () => {
		const folded = foldNonStandardRoles([
			{ role: "user", content: [{ type: "text", text: "prompt" }] },
			{ role: "system", content: [{ type: "text", text: "agent types" }] },
		]);
		expect(folded).toHaveLength(1);
		expect(folded[0]?.role).toBe("user");
		expect(folded[0]?.content).toEqual([
			{ type: "text", text: "prompt" },
			{ type: "text", text: "agent types" },
		]);
	});

	test("keeps assistant turns and does not merge across them", () => {
		const folded = foldNonStandardRoles([
			{ role: "user", content: [{ type: "text", text: "a" }] },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "system", content: [{ type: "text", text: "c" }] },
		]);
		expect(folded.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(folded[2]?.content).toEqual([{ type: "text", text: "c" }]);
	});

	test("normalizes string content so merging never mixes shapes", () => {
		const folded = foldNonStandardRoles([
			{ role: "user", content: "plain" },
			{ role: "system", content: [{ type: "text", text: "extra" }] },
		]);
		expect(folded[0]?.content).toEqual([
			{ type: "text", text: "plain" },
			{ type: "text", text: "extra" },
		]);
	});

	test("a conversation xAI already accepts keeps its meaning", () => {
		const input = [
			{ role: "user", content: [{ type: "text", text: "a" }] },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
		];
		expect(foldNonStandardRoles(structuredClone(input))).toEqual(input);
	});
});

describe("normalizeRequest", () => {
	test("fixes both rejected shapes in one pass", () => {
		const body = normalizeRequest({
			model: "grok-4.6",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "system", content: [{ type: "text", text: "ctx" }] },
			],
			tools: [{ name: "CronList", input_schema: cronListSchema() }],
		}) as { messages: { role: string }[]; tools: { input_schema: object }[] };
		expect(body.messages.map((m) => m.role)).toEqual(["user"]);
		expect(body.tools[0]?.input_schema).toHaveProperty("required", []);
	});

	test("passes a body with neither problem through untouched", () => {
		const clean = {
			model: "grok-4.6",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		};
		expect(normalizeRequest(structuredClone(clean))).toEqual(clean);
	});

	test("survives a body that is not an object", () => {
		expect(normalizeRequest(null)).toBeNull();
		expect(normalizeRequest("nonsense")).toBe("nonsense");
	});
});

/**
 * Live arm. A pure-function test cannot tell us xAI ACCEPTS the result — only
 * xAI can. Needs a token, so it is opt-in:
 *   XAI_LIVE_TEST=<oauth access token> bun test src/compat-shim.test.ts
 */
const liveToken = process.env["XAI_LIVE_TEST"];
const live = liveToken ? describe : describe.skip;

live("against the real api.x.ai", () => {
	const headers = {
		authorization: `Bearer ${liveToken}`,
		"content-type": "application/json",
	};
	const withSystemRole = {
		model: "grok-4.6",
		max_tokens: 16,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "system", content: [{ type: "text", text: "ctx" }] },
		],
	};
	const withBareSchema = {
		model: "grok-4.6",
		max_tokens: 16,
		messages: [{ role: "user", content: "hi" }],
		tools: [
			{
				name: "CronList",
				description: "list crons",
				input_schema: cronListSchema(),
			},
		],
	};

	// Negative arm: unshimmed, these are the live 400s this file exists for.
	// If xAI ever relaxes, these fail and the shim can be deleted.
	test("rejects a system-role message when sent directly", async () => {
		const res = await fetch(`${XAI}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify(withSystemRole),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("Invalid message role");
	});

	test("rejects an object schema with no required when sent directly", async () => {
		const res = await fetch(`${XAI}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify(withBareSchema),
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("/required");
	});

	// Positive arm: the same bytes through the shim.
	test("accepts both once they pass through the shim", async () => {
		const shim = startCompatShim(XAI);
		try {
			for (const body of [withSystemRole, withBareSchema]) {
				const res = await fetch(`${shim.baseUrl}/v1/messages`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});
				const text = await res.text();
				expect(text).not.toContain("invalid-argument");
				expect(res.status).toBe(200);
			}
		} finally {
			shim.stop();
		}
	}, 60_000);
});

describe("applyCompatShim", () => {
	test("points the SDK at the loopback proxy when the provider asked", () => {
		const env: Record<string, string | undefined> = {
			PICOCLAW_COMPAT: "strict-anthropic",
			ANTHROPIC_BASE_URL: XAI,
		};

		const shim = applyCompatShim(env);

		try {
			expect(shim).not.toBeNull();
			expect(env["ANTHROPIC_BASE_URL"]).toBe(shim?.baseUrl ?? "");
			expect(env["ANTHROPIC_BASE_URL"]).toStartWith("http://127.0.0.1:");
		} finally {
			shim?.stop();
		}
	});

	test("leaves a provider that did not ask alone", () => {
		const env: Record<string, string | undefined> = {
			ANTHROPIC_BASE_URL: XAI,
		};

		expect(applyCompatShim(env)).toBeNull();
		expect(env["ANTHROPIC_BASE_URL"]).toBe(XAI);
	});

	test("does nothing without a base URL to proxy", () => {
		const env: Record<string, string | undefined> = {
			PICOCLAW_COMPAT: "strict-anthropic",
		};

		expect(applyCompatShim(env)).toBeNull();
		expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
	});
});
