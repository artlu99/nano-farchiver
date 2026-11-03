import type { Cast } from "@neynar/nodejs-sdk/build/api";
import type { User } from "../lib/helpers";

export interface CastRef {
	hash: string;
	fid: number;
}

/**
 * The data surface `jobs/` and `lib/` use — the successor of the direct
 * `getDb()` calls. Two implementations:
 *   - `SqliteArchiveData` (src/data/sqlite.ts): today's bun:sqlite behavior,
 *     verbatim. The default until cutover.
 *   - `StoreArchiveData` (src/data/store.ts): bucket-backed (ArchiveStore +
 *     meta/index.json) — the archiver service path.
 * All methods are async so both backends satisfy one interface. Hash-form
 * handling (0x vs bare) is each implementation's business; callers pass
 * whatever they have.
 */
export interface ArchiveData {
	/** Tombstone check — authoritative over `casts`. Checks both hash forms. */
	isDeleted(hash: string): Promise<boolean>;
	/** Tombstone write (INSERT OR IGNORE semantics). */
	markDeleted(
		hashes: string[],
		reason: string,
		deletedAt: number,
	): Promise<void>;
	/** Drop hashes that have tombstones (input may mix 0x/bare forms). */
	filterNotDeleted(hashes: string[]): Promise<string[]>;
	/** Known cast (row or tombstone) — powers the pagination short-circuit. */
	hasCast(hash: string): Promise<boolean>;
	/** Raw stored cast JSON. `fid` narrows like `WHERE hash = ? AND fid = ?`. */
	getCastData(hash: string, fid?: number): Promise<string | undefined>;
	/** Live reply count: casts with parent_hash = hash AND parent_fid = fid. */
	countReplies(fid: number, hash: string): Promise<number>;
	/** All casts, hash-ordered (castsLoop's scan order). */
	listCasts(): Promise<CastRef[]>;
	listCastHashesByFid(fid: number): Promise<string[]>;
	/** Anti-joins: referenced parents / quotes absent from the archive. */
	missingParentHashes(): Promise<string[]>;
	missingQuotedHashes(): Promise<string[]>;
	/**
	 * Idempotent batch insert (INSERT OR IGNORE per cast + user + quotes).
	 * Tombstoned casts are never resurrected.
	 */
	tagCasts(casts: Cast[]): Promise<void>;
	getUser(fid: number): Promise<User | undefined>;
	listUserFids(): Promise<number[]>;
}
