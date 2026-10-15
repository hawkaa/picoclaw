/**
 * pi-durable ships a SQLite adapter for `node:sqlite` only, which Bun does not
 * implement ("No such built-in module: node:sqlite" on Bun 1.3.13). This is the
 * same adapter over `bun:sqlite`: one connection, every operation and
 * transaction serialized through one queue, prepared statements cached by SQL.
 */
import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type SqliteDatabase,
	type SqliteExecutor,
	SqliteStorage,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

type Scope = { active: boolean };

class Executor implements SqliteExecutor {
	constructor(
		protected readonly db: Database,
		protected readonly statements: Map<string, Statement>,
		private readonly scope?: Scope,
	) {}

	protected op<T>(fn: () => T): Promise<T> {
		if (this.scope && !this.scope.active) {
			return Promise.reject(
				new Error("SQLite transaction handle is no longer active"),
			);
		}
		try {
			return Promise.resolve(fn());
		} catch (err) {
			return Promise.reject(err);
		}
	}

	private stmt(sql: string): Statement {
		let s = this.statements.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.statements.set(sql, s);
		}
		return s;
	}

	exec(sql: string): Promise<void> {
		return this.op(() => {
			this.db.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.op(() => {
			this.stmt(sql).run(...(params as never[]));
		});
	}

	get<T extends object>(
		sql: string,
		...params: SqliteValue[]
	): Promise<T | undefined> {
		// bun:sqlite returns null for no row; the facade contract is undefined.
		return this.op(
			() =>
				(this.stmt(sql).get(...(params as never[])) as T | null) ?? undefined,
		);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.op(() => this.stmt(sql).all(...(params as never[])) as T[]);
	}
}

export class BunSqliteDatabase extends Executor implements SqliteDatabase {
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;

	constructor(db: Database) {
		super(db, new Map());
	}

	/** Every operation, transaction or not, runs after everything queued before it. */
	private queue<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = this.tail.then(fn);
		this.tail = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	protected override op<T>(fn: () => T): Promise<T> {
		return this.queue(fn);
	}

	transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.queue(async () => {
			this.db.exec("BEGIN IMMEDIATE");
			const scope: Scope = { active: true };
			try {
				const result = await callback(
					new Executor(this.db, this.statements, scope),
				);
				scope.active = false;
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.db.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"SQLite transaction failed and rollback failed",
					);
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.queue(() => {
			if (this.closed) return;
			this.closed = true;
			for (const s of this.statements.values()) s.finalize();
			this.statements.clear();
			try {
				this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.db.close();
			}
		});
	}
}

/** Same pragmas as pi-durable's `openNodeSqliteStorage`. */
export async function openBunSqliteStorage(
	path: string,
): Promise<SqliteStorage> {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA wal_autocheckpoint = 1000");
	return SqliteStorage.open(new BunSqliteDatabase(db));
}
