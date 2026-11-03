import type { Cast } from "@neynar/nodejs-sdk/build/api";
import type { User } from "../lib/helpers";
import type { RenderedEntryRef, RenderedIndex } from "../store/indexModel";

export interface CastRef {
	hash: string;
	fid: number;
	/** Epoch ms of the cast timestamp (drives render filenames). */
	ts: number;
}

export interface ReactionEntry {
	hash: string;
	type: string;
	updatedAt: number;
}

export interface DeletedEntry {
	hash: string;
	reason: string;
	deletedAt: number;
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

	// --- tombstone ledger / purge surface ---
	/** All tombstones, newest first (deleted_at DESC). */
	listDeleted(): Promise<DeletedEntry[]>;
	/** Remove a tombstone entirely (purge "release" resume rule). */
	unmarkDeleted(hash: string): Promise<void>;
	/**
	 * Self-heal insert: store the cast AND tombstone it (INSERT OR IGNORE
	 * semantics for both). Unlike `tagCasts`, this must not refuse
	 * tombstoned casts — restoring purged casts is its whole job.
	 */
	restoreTombstonedCast(
		cast: Cast,
		reason: string,
		deletedAt: number,
	): Promise<void>;

	// --- like-set mirror (purge) ---
	/** fid is part of the fact: likes of different fids are different rows. */
	upsertReactions(fid: number, entries: ReactionEntry[]): Promise<void>;
	/**
	 * Like-set refresh is full, never incremental: drop every reaction of
	 * `fid` that was not touched this run (staleness = an unlike).
	 */
	deleteReactionsNotIn(
		fid: number,
		keys: { hash: string; type: string }[],
	): Promise<void>;

	// --- settings (purge policy etc.) ---
	getSetting(key: string): Promise<string | undefined>;
	setSetting(key: string, value: string): Promise<void>;

	// --- skip-if-rendered map ---
	/**
	 * The `rendered` map from the index. SQLite backend returns an empty map —
	 * local-fs reads are cheap, so the render loop falls back to `sink.read`.
	 */
	listRendered(): Promise<RenderedIndex>;
	/** Batch-update render state after writes (store backend: one index commit). */
	markRendered(entries: RenderedEntryRef[]): Promise<void>;
}
