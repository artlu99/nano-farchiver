import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { mapWithConcurrency } from "../lib/concurrency";
import { normalizeHash, quoteHashes, type User } from "../lib/helpers";
import {
	type ArchiveIndex,
	type CastIndexEntry,
	castKey,
	commitIndex,
	deletedKey,
	emptyIndex,
	getJSON,
	listAllKeys,
	loadIndex,
	previewOf,
	putJSON,
	type RenderedEntryRef,
	type RenderedIndex,
	reactionKey,
	saveIndex,
	settingKey,
	userKey,
} from "../store/indexModel";
import {
	type ArchiveStore,
	bytesToText,
	PreconditionFailedError,
} from "../store/types";
import type {
	ArchiveData,
	CastRef,
	DeletedEntry,
	ReactionEntry,
} from "./types";

/**
 * Bucket-backed ArchiveData: `casts/*` / `users/*` / `deleted/*` objects are
 * truth, `meta/index.json` is the read cache (MIGRATION.md §3). Writes go
 * objects-first, then one If-Match index commit — the archiver-service path
 * (single writer).
 */
export class StoreArchiveData implements ArchiveData {
	private readonly store: ArchiveStore;
	/**
	 * Per-instance index cache. The archiver is the single writer for the
	 * duration of a run, so cached reads are authoritative; the TTL only
	 * guards a future second writer. Every commit updates the cache.
	 */
	private cachedIndex:
		| {
				index: ArchiveIndex;
				etag?: string;
				at: number;
		  }
		| undefined;
	/** Set while `deferCommits()` is active: index mutations stay in memory. */
	private deferred: { etag?: string } | undefined;

	constructor(store: ArchiveStore) {
		this.store = store;
	}

	private async readIndex(): Promise<ArchiveIndex> {
		if (this.deferred && this.cachedIndex) {
			return this.cachedIndex.index; // authoritative while deferring
		}
		if (
			this.cachedIndex &&
			Date.now() - this.cachedIndex.at < INDEX_CACHE_TTL_MS
		) {
			return this.cachedIndex.index;
		}
		const loaded = await loadIndex(this.store);
		this.cachedIndex = {
			index: loaded?.index ?? emptyIndex(),
			etag: loaded?.etag,
			at: Date.now(),
		};
		return this.cachedIndex.index;
	}

	private setCachedIndex(index: ArchiveIndex, etag?: string): void {
		this.cachedIndex = { index, etag, at: Date.now() };
	}

	/**
	 * Mutate the index through the active commit mode: immediate (conditional
	 * RMW per call, awaited — tombstone-before-submit ordering depends on it)
	 * or deferred (in-memory; one PUT at `flushCommits()`).
	 */
	private async commit(mutate: (draft: ArchiveIndex) => void): Promise<void> {
		if (this.deferred) {
			const cached = this.cachedIndex;
			if (!cached) return;
			mutate(cached.index);
			cached.at = Date.now();
			return;
		}
		const committed = await commitIndex(this.store, mutate);
		this.setCachedIndex(committed.index, committed.etag);
	}

	async deferCommits(): Promise<void> {
		await this.readIndex(); // populate the cache + etag before deferring
		this.deferred = { etag: this.cachedIndex?.etag };
	}

	async flushCommits(): Promise<void> {
		const state = this.deferred;
		this.deferred = undefined;
		if (!state) return;
		const cached = this.cachedIndex;
		if (!cached) return;
		cached.index.updatedAt = Date.now();
		let etag = state.etag;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const result = await saveIndex(this.store, cached.index, etag);
				this.setCachedIndex(cached.index, result.etag);
				return;
			} catch (error) {
				if (error instanceof PreconditionFailedError) {
					// Single-writer means this should not happen; if it does,
					// accept the remote etag and overwrite with our full state.
					console.warn(
						"flushCommits: index changed underneath — overwriting with local run state",
					);
					const loaded = await loadIndex(this.store);
					etag = loaded?.etag;
					continue;
				}
				throw error;
			}
		}
		throw new Error(
			"flushCommits: could not commit the index after 3 attempts",
		);
	}

	async isDeleted(hash: string): Promise<boolean> {
		const index = await this.readIndex();
		return index.deleted[normalizeHash(hash)] !== undefined;
	}

	async markDeleted(
		hashes: string[],
		reason: string,
		deletedAt: number,
	): Promise<void> {
		const normalized = [...new Set(hashes.map(normalizeHash))];
		if (normalized.length === 0) return;
		// Objects first (create-only — INSERT OR IGNORE), then the index commit.
		await mapWithConcurrency(normalized, PUT_CONCURRENCY, async (hash) =>
			putJSON(
				this.store,
				deletedKey(hash),
				{ reason, deleted_at: deletedAt },
				{
					ifNoneMatch: "*",
				},
			).catch(() => {
				// already tombstoned — ignore matches the SQLite semantics
			}),
		);
		await this.commit((index) => {
			for (const hash of normalized) {
				index.deleted[hash] = [reason, deletedAt];
			}
		});
	}

	async filterNotDeleted(hashes: string[]): Promise<string[]> {
		const index = await this.readIndex();
		return hashes
			.map(normalizeHash)
			.filter((hash) => index.deleted[hash] === undefined);
	}

	async hasCast(hash: string): Promise<boolean> {
		const key = normalizeHash(hash);
		const index = await this.readIndex();
		return index.casts[key] !== undefined || index.deleted[key] !== undefined;
	}

	async getCastData(hash: string, fid?: number): Promise<string | undefined> {
		const key = normalizeHash(hash);
		const index = await this.readIndex();
		const entry = index.casts[key];
		if (!entry) return undefined;
		if (fid !== undefined && entry[0] !== fid) return undefined;
		const obj = await this.store.get(castKey(key));
		return obj ? bytesToText(obj.body) : undefined;
	}

	async countReplies(fid: number, hash: string): Promise<number> {
		const parentKey = normalizeHash(hash);
		const index = await this.readIndex();
		let count = 0;
		for (const entry of Object.values(index.casts)) {
			if (entry[2] === parentKey && entry[3] === fid) count += 1;
		}
		return count;
	}

	async listCasts(): Promise<CastRef[]> {
		const index = await this.readIndex();
		const refs: CastRef[] = [];
		for (const hash of Object.keys(index.casts).sort()) {
			const entry = index.casts[hash];
			if (entry) refs.push({ hash, fid: entry[0], ts: entry[1] });
		}
		return refs;
	}

	async listCastHashesByFid(fid: number): Promise<string[]> {
		const index = await this.readIndex();
		const hashes: string[] = [];
		for (const [hash, entry] of Object.entries(index.casts)) {
			if (entry[0] === fid) hashes.push(hash);
		}
		return hashes;
	}

	async missingParentHashes(): Promise<string[]> {
		const index = await this.readIndex();
		const missing: string[] = [];
		for (const entry of Object.values(index.casts)) {
			const parentHash = entry[2];
			if (
				parentHash &&
				index.casts[parentHash] === undefined &&
				index.deleted[parentHash] === undefined
			) {
				missing.push(parentHash);
			}
		}
		return [...new Set(missing)];
	}

	async missingQuotedHashes(): Promise<string[]> {
		const index = await this.readIndex();
		const missing: string[] = [];
		for (const quotes of Object.values(index.quotes)) {
			for (const quoted of quotes) {
				if (
					index.casts[quoted] === undefined &&
					index.deleted[quoted] === undefined
				) {
					missing.push(quoted);
				}
			}
		}
		return [...new Set(missing)];
	}

	async tagCasts(casts: Cast[]): Promise<void> {
		if (casts.length === 0) return;
		const index = await this.readIndex();

		// Classify the batch against the current index (INSERT OR IGNORE).
		const freshCasts: { hash: string; cast: Cast }[] = [];
		const userEntries: {
			fid: number;
			username: string | null;
			cast: Cast;
		}[] = [];
		const seen = new Set<string>();
		for (const cast of casts) {
			const hash = normalizeHash(cast.hash);
			if (index.deleted[hash] !== undefined || seen.has(hash)) continue;
			seen.add(hash);
			const fid = cast.author?.fid ?? 0;
			if (index.casts[hash] === undefined) {
				freshCasts.push({ hash, cast });
			}
			if (fid !== 0 && index.users[String(fid)] === undefined) {
				userEntries.push({
					fid,
					username: cast.author?.username ?? null,
					cast,
				});
			}
		}

		// Objects first: users, casts (content-addressed, idempotent).
		await mapWithConcurrency(
			userEntries,
			PUT_CONCURRENCY,
			async ({ fid, username, cast }) =>
				putJSON(this.store, userKey(fid), {
					fid,
					username,
					displayName: cast.author?.display_name ?? null,
					avatar: cast.author?.pfp_url ?? null,
					bio: cast.author?.profile?.bio?.text ?? null,
				}),
		);
		await mapWithConcurrency(
			freshCasts,
			PUT_CONCURRENCY,
			// verbatim JSON text — same bytes the SQLite `data` column held
			async ({ hash, cast }) =>
				this.store.put(castKey(hash), JSON.stringify(cast)),
		);

		// One index commit for the whole batch (last: reply-count bumps for
		// parents already present — the live counter replaces countReplies SQL).
		await this.commit((draft) => {
			for (const { fid, username } of userEntries) {
				draft.users[String(fid)] = { username };
			}
			for (const { hash, cast } of freshCasts) {
				const parentHash = cast.parent_hash
					? normalizeHash(cast.parent_hash)
					: null;
				const parentFid = cast.parent_author?.fid ?? null;
				const tsMs = cast.timestamp ? Date.parse(cast.timestamp) : Number.NaN;
				draft.casts[hash] = [
					cast.author?.fid ?? 0,
					Number.isFinite(tsMs) ? tsMs : 0,
					parentHash,
					parentFid,
					0,
					previewOf(cast.text ?? ""),
				];
				const quotes = [...new Set(quoteHashes(cast))];
				if (quotes.length > 0) {
					draft.quotes[hash] = [
						...new Set([...(draft.quotes[hash] ?? []), ...quotes]),
					];
				}
			}
			for (const { cast } of freshCasts) {
				if (!cast.parent_hash) continue;
				const parentKey = normalizeHash(cast.parent_hash);
				const parent = draft.casts[parentKey];
				if (parent) parent[4] += 1;
			}
		});
	}

	async getUser(fid: number): Promise<User | undefined> {
		return (await getJSON<User>(this.store, userKey(fid))) ?? undefined;
	}

	async listUserFids(): Promise<number[]> {
		const index = await this.readIndex();
		return Object.keys(index.users)
			.map(Number)
			.filter((fid) => Number.isFinite(fid));
	}

	async listDeleted(): Promise<DeletedEntry[]> {
		const index = await this.readIndex();
		const entries: DeletedEntry[] = Object.entries(index.deleted).map(
			([hash, [reason, deletedAt]]) => ({
				hash,
				reason,
				deletedAt,
			}),
		);
		return entries.sort((a, b) => b.deletedAt - a.deletedAt);
	}

	async unmarkDeleted(hash: string): Promise<void> {
		const key = normalizeHash(hash);
		await this.store.deleteKey(deletedKey(key));
		await this.commit((draft) => {
			delete draft.deleted[key];
		});
	}

	async restoreTombstonedCast(
		cast: Cast,
		reason: string,
		deletedAt: number,
	): Promise<void> {
		const hash = normalizeHash(cast.hash);
		const entry = indexEntryFor(cast);
		// Objects first (create-only = INSERT OR IGNORE), then one index commit
		// carrying both the casts entry and the tombstone.
		await this.store
			.put(castKey(hash), JSON.stringify(cast), { ifNoneMatch: "*" })
			.catch(() => {
				// already archived — keep existing bytes
			});
		await putJSON(
			this.store,
			deletedKey(hash),
			{ reason, deleted_at: deletedAt },
			{ ifNoneMatch: "*" },
		).catch(() => {
			// already tombstoned
		});
		await this.commit((draft) => {
			if (draft.casts[hash] === undefined) draft.casts[hash] = entry;
			draft.deleted[hash] ??= [reason, deletedAt];
		});
	}

	async upsertReactions(fid: number, entries: ReactionEntry[]): Promise<void> {
		if (entries.length === 0) return;
		await mapWithConcurrency(entries, PUT_CONCURRENCY, async (entry) =>
			putJSON(this.store, reactionKey(fid, entry.hash, entry.type), {
				updated_at: entry.updatedAt,
			}),
		);
	}

	async deleteReactionsNotIn(
		fid: number,
		keys: { hash: string; type: string }[],
	): Promise<void> {
		const prefix = `reactions/${fid}/`;
		const keep = new Set(
			keys.map((key) => reactionKey(fid, key.hash, key.type)),
		);
		const existing = await listAllKeys(this.store, prefix);
		const stale = existing.filter((key) => !keep.has(key));
		await mapWithConcurrency(stale, PUT_CONCURRENCY, (key) =>
			this.store.deleteKey(key),
		);
	}

	async getSetting(key: string): Promise<string | undefined> {
		const stored = await getJSON<{ value: string }>(
			this.store,
			settingKey(key),
		);
		return stored?.value;
	}

	async setSetting(key: string, value: string): Promise<void> {
		await putJSON(this.store, settingKey(key), {
			value,
			updated_at: Date.now(),
		});
	}

	async listRendered(): Promise<RenderedIndex> {
		return (await this.readIndex()).rendered;
	}

	async markRendered(entries: RenderedEntryRef[]): Promise<void> {
		if (entries.length === 0) return;
		await this.commit((draft) => {
			for (const { username, filename, embedsFp, replyCount } of entries) {
				const files = draft.rendered[username] ?? {};
				files[filename] = { embedsFp, replyCount };
				draft.rendered[username] = files;
			}
		});
	}
}

const PUT_CONCURRENCY = 8;
const INDEX_CACHE_TTL_MS = 60_000;

/** Index tuple builder shared by tagCasts and restoreTombstonedCast. */
const indexEntryFor = (cast: Cast): CastIndexEntry => {
	const parentHash = cast.parent_hash ? normalizeHash(cast.parent_hash) : null;
	const parentFid = cast.parent_author?.fid ?? null;
	const tsMs = cast.timestamp ? Date.parse(cast.timestamp) : Number.NaN;
	return [
		cast.author?.fid ?? 0,
		Number.isFinite(tsMs) ? tsMs : 0,
		parentHash,
		parentFid,
		0,
		previewOf(cast.text ?? ""),
	];
};
