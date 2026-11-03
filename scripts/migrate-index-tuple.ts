/**
 * One-time index schema migration: casts entries written by the first
 * import are 5-tuples [fid, ts, parentHash, replyCount, preview]; the code
 * expects 6-tuples [fid, ts, parentHash, parentFid, replyCount, preview].
 * Rebuilds every nonconforming entry from its cast object (the truth) and
 * commits the index ONCE. Idempotent: 6-tuple entries are skipped.
 *   bun scripts/migrate-index-tuple.ts
 */

import { mapWithConcurrency } from "../src/lib/concurrency";
import { normalizeHash } from "../src/lib/helpers";
import {
	type CastIndexEntry,
	castKey,
	loadIndex,
	previewOf,
	saveIndex,
} from "../src/store/indexModel";
import { S3Store, s3ConfigFromEnv } from "../src/store/s3";
import { bytesToText } from "../src/store/types";

const store = new S3Store(s3ConfigFromEnv());
const loaded = await loadIndex(store);
if (!loaded) {
	console.error("no meta/index.json in the bucket — run import:s3 first");
	process.exit(1);
}
const index = loaded.index;

const hashes = Object.keys(index.casts);
const stale = hashes.filter((hash) => (index.casts[hash]?.length ?? 0) !== 6);
console.log(
	`index: ${hashes.length} casts, ${stale.length} with legacy 5-tuple shape`,
);
if (stale.length === 0) {
	console.log("nothing to migrate");
	process.exit(0);
}

let migrated = 0;
await mapWithConcurrency(stale, 10, async (hash) => {
	const old = index.casts[hash] ?? [];
	const [fid, ts, parentHash, replyCount, preview] = old as unknown as [
		number,
		number,
		string | null,
		number,
		string,
	];
	let parentFid: number | null = null;
	let text = preview;
	const obj = await store.get(castKey(normalizeHash(hash)));
	if (obj) {
		try {
			const cast = JSON.parse(bytesToText(obj.body)) as {
				parent_author?: { fid?: number };
				text?: string;
			};
			parentFid = cast.parent_author?.fid ?? null;
			text = cast.text ?? preview;
		} catch {
			// malformed object — keep the old preview
		}
	}
	const entry: CastIndexEntry = [
		fid,
		ts,
		parentHash,
		parentFid,
		replyCount,
		previewOf(text),
	];
	index.casts[hash] = entry;
	migrated += 1;
});

index.updatedAt = Date.now();
await saveIndex(store, index, loaded.etag);
console.log(
	`migrated ${migrated} entries — index committed (etag ${loaded.etag?.slice(0, 12) ?? "none"}…)`,
);
