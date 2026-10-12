import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { quoteHashes } from "./helpers";

export const DEFAULT_DB_PATH = "db/queue.db3";

let instance: Database | undefined;

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, username TEXT, displayName TEXT, avatar TEXT, bio TEXT)",
	"CREATE TABLE IF NOT EXISTS casts (hash TEXT PRIMARY KEY, fid INTEGER, data TEXT, parent_fid INTEGER, parent_hash TEXT)",
	"CREATE TABLE IF NOT EXISTS deleted_casts (hash TEXT PRIMARY KEY, deleted_at INTEGER, reason TEXT)",
	"CREATE TABLE IF NOT EXISTS cast_quotes (cast_hash TEXT, quoted_hash TEXT, PRIMARY KEY (cast_hash, quoted_hash))",
	"CREATE INDEX IF NOT EXISTS idx_casts_parent ON casts(parent_hash, parent_fid)",
];

const quotesTableExisted = (db: Database): boolean =>
	!!db
		.query(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cast_quotes'",
		)
		.get();

const backfillCastQuotes = (db: Database) => {
	const rows = db.query("SELECT hash, data FROM casts").all() as {
		hash: string;
		data: string;
	}[];
	if (rows.length === 0) return;
	const insert = db.prepare(
		"INSERT OR IGNORE INTO cast_quotes (cast_hash, quoted_hash) VALUES (?, ?)",
	);
	const tx = db.transaction((rows: { hash: string; data: string }[]) => {
		for (const row of rows) {
			try {
				const cast = JSON.parse(row.data) as Cast;
				for (const quoted of quoteHashes(cast)) {
					insert.run(row.hash, quoted);
				}
			} catch {
				// skip malformed rows
			}
		}
	});
	tx(rows);
};

export const initDb = (filePath: string = DEFAULT_DB_PATH): Database => {
	instance?.close();
	if (filePath !== ":memory:") {
		mkdirSync(path.dirname(filePath), { recursive: true });
	}
	const db = new Database(filePath);
	db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA synchronous = NORMAL;");
	const needsBackfill = !quotesTableExisted(db);
	for (const statement of SCHEMA) {
		db.run(statement);
	}
	if (needsBackfill) {
		backfillCastQuotes(db);
	}
	instance = db;
	return db;
};

export const getDb = (): Database => instance ?? initDb();
