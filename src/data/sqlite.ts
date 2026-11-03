import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { getDb } from "../lib/db";
import { normalizeHash, quoteHashes, type User } from "../lib/helpers";
import type { ArchiveData, CastRef } from "./types";

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
		return getDb()
			.query("SELECT hash, fid FROM casts ORDER BY hash")
			.all() as CastRef[];
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
}

const splitForms = (hash: string): [string, string] => {
	const with0x = normalizeHash(hash);
	return [with0x, with0x.replace(/^0x/, "")];
};
