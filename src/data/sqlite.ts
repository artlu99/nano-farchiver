import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { getDb } from "../lib/db";
import { normalizeHash, quoteHashes, type User } from "../lib/helpers";
import type { RenderedEntryRef, RenderedIndex } from "../store/indexModel";
import type {
	ArchiveData,
	CastRef,
	DeletedEntry,
	ReactionEntry,
} from "./types";

/**
 * bun:sqlite ArchiveData — the SQL moved verbatim out of jobs/read.ts so the
 * default context keeps today's exact behavior (WAL, both-hash-form lookups,
 * live countReplies). This is the backend `bun doIt` uses until cutover.
 */
export class SqliteArchiveData implements ArchiveData {
	async isDeleted(hash: string): Promise<boolean> {
		const with0x = normalizeHash(hash);
		const without0x = with0x.replace(/^0x/, "");
		const db = getDb();
		const row =
			(db
				.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
				.get(with0x) as { one: 1 } | undefined) ??
			(db
				.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
				.get(without0x) as { one: 1 } | undefined);
		return !!row;
	}

	async markDeleted(
		hashes: string[],
		reason: string,
		deletedAt: number,
	): Promise<void> {
		if (hashes.length === 0) return;
		const db = getDb();
		const insert = db.prepare(
			"INSERT OR IGNORE INTO deleted_casts (hash, deleted_at, reason) VALUES (?, ?, ?)",
		);
		const tx = db.transaction((rows: string[]) => {
			for (const hash of rows) {
				insert.run(normalizeHash(hash), deletedAt, reason);
			}
		});
		tx(hashes);
	}

	async filterNotDeleted(hashes: string[]): Promise<string[]> {
		if (hashes.length === 0) return [];
		const normalized = hashes.map(normalizeHash);
		const placeholders = normalized.map(() => "?").join(", ");
		const deleted = getDb()
			.query(`SELECT hash FROM deleted_casts WHERE hash IN (${placeholders})`)
			.all(...normalized) as { hash: string }[];
		const deletedSet = new Set(deleted.map((row) => row.hash));
		return normalized.filter((hash) => !deletedSet.has(hash));
	}

	async hasCast(hash: string): Promise<boolean> {
		if (await this.isDeleted(hash)) return true;
		const [with0x, without0x] = splitForms(hash);
		const db = getDb();
		const row =
			(db.query("SELECT 1 as one FROM casts WHERE hash = ?").get(with0x) as
				| { one: 1 }
				| undefined) ??
			(db.query("SELECT 1 as one FROM casts WHERE hash = ?").get(without0x) as
				| { one: 1 }
				| undefined);
		return !!row;
	}

	async getCastData(hash: string, fid?: number): Promise<string | undefined> {
		const [with0x, without0x] = splitForms(hash);
		const db = getDb();
		if (fid !== undefined) {
			const row =
				(db
					.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
					.get(with0x, fid) as { data: string } | undefined) ??
				(db
					.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
					.get(without0x, fid) as { data: string } | undefined);
			return row?.data;
		}
		const row =
			(db.query("SELECT data FROM casts WHERE hash = ?").get(with0x) as
				| { data: string }
				| undefined) ??
			(db.query("SELECT data FROM casts WHERE hash = ?").get(without0x) as
				| { data: string }
				| undefined);
		return row?.data;
	}

	async countReplies(fid: number, hash: string): Promise<number> {
		const res = getDb()
			.query(
				"SELECT count(1) as count FROM casts WHERE parent_hash = ? AND parent_fid = ?",
			)
			.get(normalizeHash(hash), fid) as { count: number } | undefined;
		return res?.count ?? 0;
	}

	async listCasts(): Promise<CastRef[]> {
		return (
			getDb()
				.query(
					"SELECT hash, fid, CAST(STRFTIME('%s', json_extract(data, '$.timestamp')) AS INTEGER) * 1000 AS ts FROM casts ORDER BY hash",
				)
				.all() as { hash: string; fid: number; ts: number | null }[]
		).map((row) => ({ hash: row.hash, fid: row.fid, ts: row.ts ?? 0 }));
	}

	async listCastHashesByFid(fid: number): Promise<string[]> {
		return (
			getDb().query("SELECT hash FROM casts WHERE fid = ?").all(fid) as {
				hash: string;
			}[]
		).map((row) => row.hash);
	}

	async missingParentHashes(): Promise<string[]> {
		return (
			getDb()
				.query(
					`
SELECT DISTINCT parent_hash as hash
FROM casts
WHERE parent_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM casts c2 WHERE c2.hash = casts.parent_hash)
  AND NOT EXISTS (SELECT 1 FROM deleted_casts d WHERE d.hash = casts.parent_hash)
`,
				)
				.all() as { hash: string }[]
		).map((row) => row.hash);
	}

	async missingQuotedHashes(): Promise<string[]> {
		return (
			getDb()
				.query(
					`
SELECT DISTINCT quoted_hash as hash
FROM cast_quotes
WHERE NOT EXISTS (SELECT 1 FROM casts c WHERE c.hash = cast_quotes.quoted_hash)
  AND NOT EXISTS (SELECT 1 FROM deleted_casts d WHERE d.hash = cast_quotes.quoted_hash)
`,
				)
				.all() as { hash: string }[]
		).map((row) => row.hash);
	}

	async tagCasts(casts: Cast[]): Promise<void> {
		if (casts.length === 0) return;
		const db = getDb();
		const userInsert = db.prepare(
			"INSERT INTO users (fid, username, displayName, avatar, bio) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
		);
		const castInsert = db.prepare(
			"INSERT INTO casts (hash, fid, data, parent_fid, parent_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
		);
		const quoteInsert = db.prepare(
			"INSERT OR IGNORE INTO cast_quotes (cast_hash, quoted_hash) VALUES (?, ?)",
		);
		const isDeletedRow = (hash: string): boolean =>
			!!db
				.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
				.get(normalizeHash(hash));
		const tx = db.transaction((rows: Cast[]) => {
			for (const cast of rows) {
				const normalizedHash = normalizeHash(cast.hash);
				// Tombstones are authoritative: stale conversations must not
				// resurrect a deleted cast into `casts`.
				if (isDeletedRow(normalizedHash)) continue;
				const normalizedParentHash = cast.parent_hash
					? normalizeHash(cast.parent_hash)
					: cast.parent_hash;
				userInsert.run(
					cast.author.fid,
					cast.author.username ?? null,
					cast.author.display_name ?? null,
					cast.author.pfp_url ?? null,
					cast.author.profile.bio.text ?? null,
				);
				castInsert.run(
					normalizedHash,
					cast.author.fid,
					JSON.stringify(cast),
					cast.parent_author?.fid,
					normalizedParentHash,
				);
				for (const quoted of quoteHashes(cast)) {
					quoteInsert.run(normalizedHash, quoted);
				}
			}
		});
		tx(casts);
	}

	async getUser(fid: number): Promise<User | undefined> {
		return getDb()
			.query(
				"SELECT fid, username, displayName, avatar, bio FROM users WHERE fid = ?",
			)
			.get(fid) as User | undefined;
	}

	async listUserFids(): Promise<number[]> {
		return (
			getDb().query("SELECT fid FROM users").all() as { fid: number }[]
		).map((row) => row.fid);
	}

	async listDeleted(): Promise<DeletedEntry[]> {
		return (
			getDb()
				.query(
					"SELECT hash, reason, deleted_at FROM deleted_casts ORDER BY deleted_at DESC",
				)
				.all() as { hash: string; reason: string; deleted_at: number }[]
		).map((row) => ({
			hash: row.hash,
			reason: row.reason,
			deletedAt: row.deleted_at,
		}));
	}

	async unmarkDeleted(hash: string): Promise<void> {
		getDb()
			.prepare("DELETE FROM deleted_casts WHERE hash = ?")
			.run(normalizeHash(hash));
	}

	async restoreTombstonedCast(
		cast: Cast,
		reason: string,
		deletedAt: number,
	): Promise<void> {
		const db = getDb();
		const normalizedHash = normalizeHash(cast.hash);
		const normalizedParentHash = cast.parent_hash
			? normalizeHash(cast.parent_hash)
			: cast.parent_hash;
		const tx = db.transaction(() => {
			db.prepare(
				"INSERT INTO casts (hash, fid, data, parent_fid, parent_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
			).run(
				normalizedHash,
				cast.author?.fid ?? 0,
				JSON.stringify(cast),
				cast.parent_author?.fid,
				normalizedParentHash,
			);
			db.prepare(
				"INSERT OR IGNORE INTO deleted_casts (hash, deleted_at, reason) VALUES (?, ?, ?)",
			).run(normalizedHash, deletedAt, reason);
		});
		tx();
	}

	async upsertReactions(fid: number, entries: ReactionEntry[]): Promise<void> {
		if (entries.length === 0) return;
		// self_reactions predates multi-fid: the table has no fid column (all
		// rows belong to the single archived fid). The store backend keys by fid.
		void fid;
		const db = getDb();
		const upsert = db.prepare(
			"INSERT INTO self_reactions (target_hash, type, updated_at) VALUES (?, ?, ?) ON CONFLICT(target_hash, type) DO UPDATE SET updated_at = excluded.updated_at",
		);
		const tx = db.transaction((rows: ReactionEntry[]) => {
			for (const entry of rows) {
				upsert.run(normalizeHash(entry.hash), entry.type, entry.updatedAt);
			}
		});
		tx(entries);
	}

	async deleteReactionsNotIn(
		fid: number,
		keys: { hash: string; type: string }[],
	): Promise<void> {
		void fid;
		const db = getDb();
		if (keys.length === 0) {
			db.prepare("DELETE FROM self_reactions").run();
			return;
		}
		const keepKeys = keys.map(
			(key) => `${normalizeHash(key.hash)}#${key.type}`,
		);
		const placeholders = keepKeys.map(() => "?").join(", ");
		db.prepare(
			`DELETE FROM self_reactions WHERE (target_hash || '#' || type) NOT IN (${placeholders})`,
		).run(...keepKeys);
	}

	async getSetting(key: string): Promise<string | undefined> {
		const row = getDb()
			.query("SELECT value FROM settings WHERE key = ?")
			.get(key) as { value: string } | undefined;
		return row?.value;
	}

	async setSetting(key: string, value: string): Promise<void> {
		getDb()
			.prepare(
				"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			)
			.run(key, value, Date.now());
	}

	/** Local-fs renders are read directly by the render loop; no map needed. */
	async listRendered(): Promise<RenderedIndex> {
		return {};
	}

	async markRendered(_entries: RenderedEntryRef[]): Promise<void> {
		// no-op: the SQLite backend checks renders via the fs sink
	}
}

const splitForms = (hash: string): [string, string] => {
	const with0x = normalizeHash(hash);
	return [with0x, with0x.replace(/^0x/, "")];
};
