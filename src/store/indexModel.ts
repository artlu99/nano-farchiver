import { normalizeHash, strip0x } from "../lib/helpers";
import type { ArchiveStore, PutOptions, PutResult } from "./types";
import { bytesToText, PreconditionFailedError } from "./types";

// ---------------------------------------------------------------------------
// Bucket key layout (MIGRATION.md §3) — the shared contract between the
// read-only `web` service and the read-write `archiver` service.
// Hash-bearing keys are stored 0x-less; normalize at the call site via these
// builders so the old double-form lookups never leak into store callers.
// ---------------------------------------------------------------------------

const no0x = (hash: string): string => strip0x(normalizeHash(hash));

export const INDEX_KEY = "meta/index.json";
export const castKey = (hash: string): string => `casts/${no0x(hash)}.json`;
export const userKey = (fid: number): string => `users/${fid}.json`;
export const deletedKey = (hash: string): string =>
	`deleted/${no0x(hash)}.json`;
export const settingKey = (key: string): string => `settings/${key}.json`;
/** self_reactions, fid-scoped for multi-FID (R3). `type` is "like" | "recast". */
export const reactionKey = (
	fid: number,
	targetHash: string,
	type: string,
): string => `reactions/${fid}/${no0x(targetHash)}#${type}.json`;
export const fidRegistryKey = (fid: number): string => `fids/${fid}.json`;
export const outKey = (username: string, filename: string): string =>
	`out/${username}/${filename}`;
export const backupManifestKey = "backups/manifest.jsonl";
export const backupCheckpointKey = "backups/CHECKPOINT.json";
export const textfiltersKey = "config/textfilters.jsonl";
export const runStatusKey = "meta/run-status.json";
export const runRequestKey = "meta/run-request";

/** Last-writer-wins progress object for the landing page's live run section
 *  (no If-Match). */
export const writeRunStatus = (
	store: ArchiveStore,
	progress: unknown,
): Promise<PutResult> => store.put(runStatusKey, JSON.stringify(progress));

// ---------------------------------------------------------------------------
// Index shape — `casts/*` etc. objects are truth; this is the rebuildable
// read cache that replaces SQLite queries (timeline sort, hasCastInDb,
// anti-joins, counts). `preview` keeps /timeline free of per-row object GETs.
// ---------------------------------------------------------------------------

export type CastIndexEntry = [
	fid: number,
	ts: number,
	parentHash: string | null,
	parentFid: number | null,
	replyCount: number,
	preview: string,
];
export type DeletedIndexEntry = [reason: string, deletedAt: number];

export interface RenderedEntry {
	embedsFp: string;
	replyCount: number;
}

/** username → filename → render state (the skip-if-rendered map). */
export type RenderedIndex = Record<string, Record<string, RenderedEntry>>;

export interface RenderedEntryRef {
	username: string;
	filename: string;
	embedsFp: string;
	replyCount: number;
}

export interface FidRegistryIndexEntry {
	active: boolean;
	username?: string | null;
	lastRunAt?: number;
}

export interface ArchiveIndex {
	version: 1;
	updatedAt: number;
	casts: Record<string, CastIndexEntry>;
	deleted: Record<string, DeletedIndexEntry>;
	quotes: Record<string, string[]>;
	users: Record<string, { username: string | null }>;
	fids: Record<string, FidRegistryIndexEntry>;
	rendered: Record<string, Record<string, RenderedEntry>>;
}

export const emptyIndex = (): ArchiveIndex => ({
	version: 1,
	updatedAt: 0,
	casts: {},
	deleted: {},
	quotes: {},
	users: {},
	fids: {},
	rendered: {},
});

export const PREVIEW_LENGTH = 200;
export const previewOf = (text: string): string =>
	text.slice(0, PREVIEW_LENGTH);

/** Cheap, sync, stable fingerprint of a cast's embeds (skip-if-rendered check). */
export const embedsFingerprint = (embeds: unknown): string => {
	const json = JSON.stringify(embeds ?? []);
	let hash = 0x811c9dc5; // FNV-1a 32-bit
	for (let i = 0; i < json.length; i++) {
		hash ^= json.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
};

// ---------------------------------------------------------------------------
// JSON conveniences
// ---------------------------------------------------------------------------

export const getJSON = async <T>(
	store: ArchiveStore,
	key: string,
): Promise<T | null> => {
	const obj = await store.get(key);
	if (!obj) return null;
	return JSON.parse(bytesToText(obj.body)) as T;
};

export const putJSON = (
	store: ArchiveStore,
	key: string,
	value: unknown,
	options?: PutOptions,
): Promise<PutResult> => store.put(key, JSON.stringify(value), options);

// ---------------------------------------------------------------------------
// Index load/commit — optimistic If-Match RMW. Safe under the single-writer
// rule; on providers without conditional PUTs the check-then-put is advisory
// (MIGRATION.md §3.1 / §10.1).
// ---------------------------------------------------------------------------

export interface LoadedIndex {
	index: ArchiveIndex;
	etag?: string;
}

export const loadIndex = async (
	store: ArchiveStore,
): Promise<LoadedIndex | null> => {
	const obj = await store.get(INDEX_KEY);
	if (!obj) return null;
	return {
		index: JSON.parse(bytesToText(obj.body)) as ArchiveIndex,
		etag: obj.etag,
	};
};

const saveOptions = (etag: string | undefined): PutOptions =>
	etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: etag };

export const saveIndex = async (
	store: ArchiveStore,
	index: ArchiveIndex,
	etag?: string,
): Promise<PutResult> => putJSON(store, INDEX_KEY, index, saveOptions(etag));

export interface CommittedIndex {
	index: ArchiveIndex;
	etag?: string;
}

/**
 * Read-mutate-write the index with retry on lost races. `mutate` may be async
 * but must not itself write the index.
 */
export const commitIndex = async (
	store: ArchiveStore,
	mutate: (draft: ArchiveIndex) => void | Promise<void>,
	attempts = 5,
): Promise<CommittedIndex> => {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const loaded = await loadIndex(store);
		const index: ArchiveIndex = loaded?.index ?? emptyIndex();
		await mutate(index);
		index.updatedAt = Date.now();
		try {
			const result = await saveIndex(store, index, loaded?.etag);
			return { index, etag: result.etag };
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				lastError = error;
				continue;
			}
			throw error;
		}
	}
	throw new Error(`commitIndex: lost the write race ${attempts} time(s)`, {
		cause: lastError,
	});
};

/** Fully drain a prefix (follows continuation tokens; providers cap at 1000). */
export const listAllKeys = async (
	store: ArchiveStore,
	prefix: string,
	options?: { delimiter?: string },
): Promise<string[]> => {
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const page = await store.list(prefix, {
			delimiter: options?.delimiter,
			maxKeys: 1000,
			token,
		});
		keys.push(...page.keys);
		token = page.truncated ? page.nextToken : undefined;
	} while (token);
	return keys;
};
