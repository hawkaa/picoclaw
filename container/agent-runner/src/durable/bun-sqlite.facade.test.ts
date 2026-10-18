/**
 * The SqliteDatabase facade contract from pi-durable's README §Storage, tested
 * directly. pi-durable's storage conformance suite drives the adapter only
 * through SqliteStorage, which validates before it writes and enforces close
 * itself, so a non-queueing or non-rolling-back adapter still passes it 24/24.
 */
import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { BunSqliteDatabase } from "./bun-sqlite.ts";

const open = () => new BunSqliteDatabase(new Database(":memory:"));

it("rolls back writes made before the callback throws", async () => {
	const db = open();
	await db.exec("CREATE TABLE t (v TEXT)");
	await expect(
		db.transaction(async (tx) => {
			await tx.run("INSERT INTO t (v) VALUES (?)", "lost");
			throw new Error("boom");
		}),
	).rejects.toThrow("boom");
	expect(await db.all("SELECT v FROM t")).toEqual([]);
	await db.close();
});

it("queues unrelated operations until the transaction settles", async () => {
	const db = open();
	await db.exec("CREATE TABLE t (v INTEGER)");
	const order: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const tx = db.transaction(async (t) => {
		await t.run("INSERT INTO t (v) VALUES (1)");
		await gate;
		order.push("tx");
	});
	const outside = db
		.get<{ n: number }>("SELECT count(*) AS n FROM t")
		.then((r) => {
			order.push("outside");
			return r;
		});
	await new Promise((r) => setTimeout(r, 20));
	expect(order).toEqual([]);
	release();
	await tx;
	expect(await outside).toEqual({ n: 1 });
	expect(order).toEqual(["tx", "outside"]);
	await db.close();
});

it("expires the transaction handle when the callback settles", async () => {
	const db = open();
	const leaked = await db.transaction(async (t) => t);
	await expect(leaked.exec("SELECT 1")).rejects.toThrow("no longer active");
	await db.close();
});

it("returns undefined, not null, for a missing row", async () => {
	const db = open();
	await db.exec("CREATE TABLE t (v TEXT)");
	expect(await db.get("SELECT v FROM t")).toBeUndefined();
	await db.close();
});
