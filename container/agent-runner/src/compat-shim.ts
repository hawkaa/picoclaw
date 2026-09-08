/**
 * Request-shape shim for Anthropic-compatible endpoints that are STRICTER than
 * Anthropic's own API.
 *
 * Why this exists. PicoClaw points the Claude Agent SDK at third-party
 * "Anthropic-compatible" endpoints purely through ANTHROPIC_BASE_URL. That
 * works only as far as the vendor's validator is as permissive as Anthropic's.
 * xAI's is not, and Claude Code 2.1.258 emits two shapes it rejects outright
 * (measured 2026-09-08 against https://api.x.ai/v1/messages, a real
 * `claude -p` run captured through a logging proxy):
 *
 *   1. `{"code":"invalid-argument","error":"Invalid request content: Invalid
 *      message role."}` — the CLI puts a `role:"system"` message INSIDE
 *      `messages` (it carries the agent-type listing and other mid-conversation
 *      reminders). Anthropic accepts it; xAI allows only user/assistant.
 *
 *   2. `{"code":"invalid-argument","error":"Invalid request content: Schema
 *      validation failed: [standard_violation] /required: null is not of type
 *      \"array\""}` — ten built-in tools (CronList, TaskList, Workflow, …)
 *      declare `{"type":"object","properties":{…}}` with no `required` key,
 *      which is valid JSON Schema and means "nothing is required". xAI's
 *      deserializer turns the absent key into null and then type-checks it.
 *
 * Neither is fixable from the PicoClaw side of the SDK: the SDK builds those
 * bodies. So a loopback proxy inside the container normalizes them on the wire
 * and forwards everything else untouched. It binds 127.0.0.1 on an ephemeral
 * port and is unreachable from outside the container.
 *
 * Deliberately NOT a general translation layer. It rewrites exactly the two
 * shapes above and copies the rest — headers, streaming body, status — through
 * verbatim, so a future vendor fix costs nothing and a vendor error still
 * reaches the SDK as itself.
 */

/** Content blocks, after the string form is normalized away. */
type Block = { type: string; [k: string]: unknown };
type Message = {
	role: string;
	content: string | Block[];
	[k: string]: unknown;
};

/**
 * Give every object schema an explicit `required`. Recurses through the whole
 * document because nested objects hit the same validator (`TaskCreate` fails on
 * `/properties/metadata`, not on its root).
 */
export function fillRequiredArrays(node: unknown): void {
	if (Array.isArray(node)) {
		for (const item of node) fillRequiredArrays(item);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	if (obj["type"] === "object" && !Array.isArray(obj["required"])) {
		obj["required"] = [];
	}
	for (const value of Object.values(obj)) fillRequiredArrays(value);
}

/**
 * Fold any non-user/assistant message into the user turn. Content is preserved
 * verbatim and in place — a system message dropped or hoisted to the top-level
 * `system` block would move instructions the model was meant to read at that
 * point in the conversation. Adjacent same-role messages are then merged,
 * because Anthropic-shaped APIs expect alternating roles.
 */
export function foldNonStandardRoles(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (const message of messages) {
		const role =
			message.role === "user" || message.role === "assistant"
				? message.role
				: "user";
		const content: Block[] =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		const previous = out[out.length - 1];
		if (previous && previous.role === role) {
			previous.content = [...(previous.content as Block[]), ...content];
			continue;
		}
		out.push({ ...message, role, content });
	}
	return out;
}

/** Both rewrites. Mutates and returns `body`; a non-object passes through. */
export function normalizeRequest(body: unknown): unknown {
	if (body === null || typeof body !== "object") return body;
	const doc = body as Record<string, unknown>;
	if (Array.isArray(doc["tools"])) {
		for (const tool of doc["tools"] as Array<Record<string, unknown>>) {
			fillRequiredArrays(tool?.["input_schema"]);
		}
	}
	const output = doc["output_config"] as Record<string, unknown> | undefined;
	const format = output?.["format"] as Record<string, unknown> | undefined;
	if (format?.["schema"]) fillRequiredArrays(format["schema"]);
	if (Array.isArray(doc["messages"])) {
		doc["messages"] = foldNonStandardRoles(doc["messages"] as Message[]);
	}
	return doc;
}

export interface CompatShim {
	/** Base URL to hand the SDK in place of the upstream one. */
	baseUrl: string;
	stop(): void;
}

/**
 * Start the loopback proxy. `upstream` is the real endpoint (ANTHROPIC_BASE_URL
 * as the provider config set it); the returned baseUrl replaces it.
 */
export function startCompatShim(upstream: string): CompatShim {
	const target = upstream.replace(/\/+$/, "");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		// A frontier turn with a large context can take minutes; the default
		// 10s idle timeout would sever the stream mid-answer.
		idleTimeout: 255,
		async fetch(request) {
			const url = new URL(request.url);
			const headers = new Headers(request.headers);
			// Host must describe the upstream, not the loopback listener; the
			// other two are recomputed by fetch() and go stale if a rewrite
			// changes the body length.
			headers.delete("host");
			headers.delete("content-length");
			headers.delete("accept-encoding");
			let body: string | null = null;
			if (request.method !== "GET" && request.method !== "HEAD") {
				const raw = await request.text();
				try {
					body = JSON.stringify(normalizeRequest(JSON.parse(raw)));
				} catch {
					// Not JSON (or not parseable): forward untouched rather than
					// failing a request this shim does not understand.
					body = raw;
				}
			}
			const response = await fetch(target + url.pathname + url.search, {
				method: request.method,
				headers,
				body,
			});
			// fetch() has already decoded the body, so forwarding the upstream's
			// content-encoding makes the SDK try to gunzip plain bytes (ZlibError,
			// caught by the live test: streamed replies are uncompressed, so only a
			// non-streaming call hits it). content-length would be stale for the
			// same reason. The body itself streams through untouched.
			const responseHeaders = new Headers(response.headers);
			responseHeaders.delete("content-encoding");
			responseHeaders.delete("content-length");
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		},
	});
	// The proxy must never be the reason the runner stays alive after its
	// session ends.
	server.unref?.();
	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

/**
 * Wire the shim into a container's env block, if the provider asked for it.
 * Rewrites ANTHROPIC_BASE_URL in place so the SDK talks to the loopback proxy
 * and never learns the difference. Returns null when nothing was done.
 */
export function applyCompatShim(
	env: Record<string, string | undefined>,
): CompatShim | null {
	const upstream = env["ANTHROPIC_BASE_URL"];
	if (!env["PICOCLAW_COMPAT"] || !upstream) return null;
	const shim = startCompatShim(upstream);
	env["ANTHROPIC_BASE_URL"] = shim.baseUrl;
	return shim;
}
