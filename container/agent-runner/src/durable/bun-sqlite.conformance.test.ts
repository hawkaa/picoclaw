/**
 * pi-durable's own storage conformance suite, run against the bun:sqlite
 * adapter. One fresh database file per case, closed and removed after.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openBunSqliteStorage } from "./bun-sqlite.ts";

registerStorageConformance(
	{ describe, expect: expect as never, it },
	"bun:sqlite storage",
	async (use) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-durable-bun-"));
		const storage = await openBunSqliteStorage(join(dir, "session.sqlite"));
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
