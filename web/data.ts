import {
	type ArchiveIndex,
	emptyIndex,
	loadIndex,
} from "../src/store/indexModel";
import { type Env, getStore } from "./env";

/**
 * Per-isolate index cache with a short TTL (MIGRATION.md §4.2). Every cache
 * miss is one index GET; page-level object GETs are on top of this. The
 * conditional-GET (If-None-Match) revalidation is a later refinement —
 * plain TTL revalidation keeps v1 simple and correct (≤60 s staleness).
 */
const INDEX_TTL_MS = 60_000;

let cache: { index: ArchiveIndex; at: number } | null = null;
let inflight: Promise<ArchiveIndex> | null = null;

export const getIndex = async (env: Env): Promise<ArchiveIndex> => {
	if (cache && Date.now() - cache.at < INDEX_TTL_MS) return cache.index;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const index = (await loadIndex(getStore(env)))?.index ?? emptyIndex();
			cache = { index, at: Date.now() };
			return index;
		} finally {
			inflight = null;
		}
	})();
	return inflight;
};
