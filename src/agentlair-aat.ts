// AgentLair AAT (Agent Auth Token) — issues a short-lived JWT per session.
// The token is passed into the agent container as AGENTLAIR_AAT, giving the
// agent a cryptographic identity it can use to authenticate to external
// services (e.g. prism-mcp via JWKS).
//
// The API key stays in the host; the agent only receives the JWT.
import pino from "pino";

const log = pino({ name: "agentlair-aat" });

const AGENTLAIR_BASE = "https://agentlair.dev";

interface AATResponse {
	token: string;
	token_type: string;
	expires_at: string;
	expires_in: number;
	jti: string;
	audit_url: string;
}

/**
 * Issue an AgentLair AAT for a PicoClaw agent session.
 *
 * Returns the JWT string, or undefined if issuance fails (non-blocking).
 * The token is scoped to the session and expires after 1 hour.
 */
export async function issueAAT(opts: {
	apiKey: string;
	sessionId: string;
	chatId: string;
	botName: string;
}): Promise<string | undefined> {
	try {
		const res = await fetch(`${AGENTLAIR_BASE}/v1/tokens/issue`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				audience: "https://picoclaw.local",
				scopes: ["picoclaw:session"],
				ttl: 3600,
				agent_name: `${opts.botName}/${opts.chatId}`,
			}),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn(
				{ status: res.status, body: body.slice(0, 200), bot: opts.botName },
				"AAT issuance failed",
			);
			return undefined;
		}

		const data = (await res.json()) as AATResponse;
		log.info(
			{
				jti: data.jti,
				expires_in: data.expires_in,
				bot: opts.botName,
				chatId: opts.chatId,
			},
			"AAT issued for session",
		);
		return data.token;
	} catch (err) {
		log.warn({ err, bot: opts.botName }, "AAT issuance error (non-blocking)");
		return undefined;
	}
}
