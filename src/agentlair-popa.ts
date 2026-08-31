// AgentLair PoPA (Proof of Persistent Activity) — enrolls a bot's principal
// DID with the AgentLair PoPA subscriber registry.
//
// Each enrolled DID accumulates a continuity streak: a daily attestation that
// the agent has been online and operating for N consecutive days. Without
// enrollment, no streak is recorded for that DID — only the host-level
// `did:web:agentlair.dev` (if separately enrolled).
//
// Enrollment is idempotent on the server side (UPSERT keyed on agent_did),
// so calling once per bot at host startup is the intended pattern.
import pino from "pino";

const log = pino({ name: "agentlair-popa" });

const AGENTLAIR_BASE = "https://agentlair.dev";

interface EnrollResponse {
	agent_did: string;
	account_id: string | null;
	enabled: boolean;
	enrolled_at: string;
}

/**
 * Derive the default principal DID for a PicoClaw-hosted bot.
 *
 * Format: `did:web:agentlair.dev:picoclaw:<botName>`. Per W3C did:web spec,
 * resolution would map to `https://agentlair.dev/picoclaw/<botName>/did.json`,
 * but the DID is treated here as a stable opaque identifier — AgentLair
 * does not require the document to be resolvable for PoPA enrollment.
 */
export function defaultPrincipalDid(botName: string): string {
	// Lowercase + alphanumerics/hyphens only, to keep the DID path-safe.
	const safe = botName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return `did:web:agentlair.dev:picoclaw:${safe}`;
}

/**
 * Enroll a bot's principal DID with the AgentLair PoPA registry.
 *
 * Returns the canonical subscriber row on success, or `undefined` on any
 * failure (network, auth, server error). Always non-blocking: the caller
 * must not abort startup if enrollment fails.
 *
 * The endpoint is idempotent — calling repeatedly for the same DID returns
 * the existing row with the original `enrolled_at` timestamp.
 */
export async function enrollPoPA(opts: {
	apiKey: string;
	principal: string;
	botName: string;
	enabled?: boolean | undefined;
}): Promise<EnrollResponse | undefined> {
	try {
		const res = await fetch(`${AGENTLAIR_BASE}/v1/popa/enroll`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agent_did: opts.principal,
				enabled: opts.enabled ?? true,
			}),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn(
				{
					status: res.status,
					body: body.slice(0, 200),
					bot: opts.botName,
					principal: opts.principal,
				},
				"PoPA enrollment failed (non-blocking)",
			);
			return undefined;
		}

		const data = (await res.json()) as EnrollResponse;
		log.info(
			{
				bot: opts.botName,
				principal: data.agent_did,
				enabled: data.enabled,
				enrolled_at: data.enrolled_at,
			},
			"PoPA enrolled",
		);
		return data;
	} catch (err) {
		log.warn(
			{ err, bot: opts.botName, principal: opts.principal },
			"PoPA enrollment error (non-blocking)",
		);
		return undefined;
	}
}
