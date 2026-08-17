#!/usr/bin/env bun
/**
 * AgentLair AAT verifier — lands in /workspace/agentlair-verify.ts when a
 * fresh chat workspace is seeded. Lets any agent skill verify the
 * `$AGENTLAIR_AAT` JWT injected by the host without re-implementing the
 * JWKS fetch.
 *
 * Usage (inside the container):
 *
 *   bun /workspace/agentlair-verify.ts
 *      → reads $AGENTLAIR_AAT from the environment, prints decoded claims
 *
 *   bun /workspace/agentlair-verify.ts <token>
 *      → verifies an explicit token argument
 *
 * Exit codes:
 *   0 — token valid; claims printed as JSON
 *   1 — token missing
 *   2 — token invalid (signature, expiry, issuer, audience…)
 *
 * Bun auto-installs `@agentlair/verify` on first run when no node_modules
 * exists in /workspace. Pre-cache by running once during workspace setup.
 */
// @ts-expect-error — Bun auto-installs on first import outside a project.
import { verifyAAT } from "@agentlair/verify";

const explicitToken = process.argv[2];
const token = explicitToken ?? process.env["AGENTLAIR_AAT"];

if (!token) {
	console.error(
		"agentlair-verify: no token provided.\n" +
			"  Pass as arg: bun /workspace/agentlair-verify.ts <token>\n" +
			"  Or set $AGENTLAIR_AAT in the environment.",
	);
	process.exit(1);
}

const result = await verifyAAT(token);

if (!result.valid) {
	console.error(`agentlair-verify: token rejected — ${result.error}`);
	process.exit(2);
}

// Pretty-print decoded claims for skill authors.
console.log(
	JSON.stringify(
		{
			valid: true,
			agentId: result.agentId,
			operatorEmail: result.operatorEmail,
			scopes: result.scopes,
			issuedAt: result.issuedAt,
			expiresAt: result.expiresAt,
			claims: result.claims,
		},
		null,
		2,
	),
);
