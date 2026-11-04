/**
 * Quilcast Spam scores (https://spam.quilcast.com/#api): free, no key.
 *   GET /scores?h=<hash>,<hash>  → { "<hash>": 0..1 | null }
 * Per-hash cache: scored entries 5 min (their side caches 60 s too), nulls
 * 60 s (scores appear on demand — ask again shortly). Fail-open: fetch
 * errors return no scores, which disables the filter for that render.
 */

const SCORES_URL = "https://spam.quilcast.com/scores";
const CHUNK = 100;
const TTL_SCORED_MS = 5 * 60_000;
const TTL_NULL_MS = 60_000;

interface CacheEntry {
	score: number | null;
	at: number;
}

const cache = new Map<string, CacheEntry>();

export type ScoreFetcher = (url: string) => Promise<Response>;

const defaultFetch: ScoreFetcher = (url) =>
	fetch(url, { signal: AbortSignal.timeout(5_000) });

export const getSpamScores = async (
	hashes: string[],
	fetchFn: ScoreFetcher = defaultFetch,
): Promise<Map<string, number | null>> => {
	const out = new Map<string, number | null>();
	const now = Date.now();
	const need: string[] = [];
	for (const hash of hashes) {
		const key = hash.toLowerCase();
		const entry = cache.get(key);
		if (
			entry &&
			now - entry.at < (entry.score === null ? TTL_NULL_MS : TTL_SCORED_MS)
		) {
			out.set(key, entry.score);
			continue;
		}
		need.push(key);
	}

	for (let i = 0; i < need.length; i += CHUNK) {
		const chunk = need.slice(i, i + CHUNK);
		try {
			const res = await fetchFn(`${SCORES_URL}?h=${chunk.join(",")}`);
			if (!res.ok) continue; // fail-open: no scores → no filtering
			const data = (await res.json()) as Record<string, number | null>;
			for (const [key, score] of Object.entries(data)) {
				const normalized = typeof score === "number" ? score : null;
				cache.set(key, { score: normalized, at: Date.now() });
				out.set(key, normalized);
			}
		} catch {}
	}
	return out;
};

/** Reset cache (tests). */
export const resetSpamScoreCache = (): void => cache.clear();
