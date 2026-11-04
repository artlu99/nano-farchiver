/**
 * One-off remediation for the ctx-threading bug (fixed in neynar.ts): the
 * pre-fix heal loops fetched missing casts but tagged them into the SQLite
 * default context instead of the bucket runtime, leaving meta/index.json
 * permanently missing rows — the timeline rendered "[parent unavailable]"
 * for replies whose parents existed upstream.
 *
 * Steps (single-writer: run under `flock logs/doit.lock`):
 *   1. Tag SQLite-only casts (db/queue.db3) into the bucket.
 *   2. Run the missing-parent heal (upstream by-hash fetches + tombstones
 *      for hashes upstream no longer serves).
 *   3. Repair reply-file headers rendered while the parent was missing
 *      ("replying to: [...](undefined)") for parents found in step 1/2.
 *
 *   flock -w 600 logs/doit.lock bun scripts/backfill-parents.ts
 */
import { Database } from "bun:sqlite";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { runtimeContext } from "../src/ctx";
import {
	hydrateReferencedParents,
	markCastsDeleted,
	tagCasts,
} from "../src/jobs/read";
import { castFromBackupMessage } from "../src/lib/backup";
import { hash2filename, normalizeHash } from "../src/lib/helpers";
import { renderReplyHeader } from "../src/lib/markdown";
import type { SnapMessage } from "../src/lib/snapchain";
import { loadIndex } from "../src/store/indexModel";
import { S3Store, s3ConfigFromEnv } from "../src/store/s3";

const TARGET = "0x120498d20ea12fe18dbe0a213f1268caf7673582";

const chunk = <T>(items: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
};

/**
 * Snapchain fallback for hashes the Neynar-compatible by-hash endpoint
 * refuses (502): resolve each missing hash's fid via the running fid map
 * (seeded from the committed index, extended with every fetched message's
 * own hash and parentCastId — tags are deferred in memory, so a fresh index
 * load would not know them). A 404 tombstones ("not found upstream"),
 * matching getCasts semantics.
 */
const fidOf = new Map<string, number>();
const snapchainHeal = async (missing: string[]): Promise<number> => {
	const loaded = await loadIndex(store);
	if (loaded) {
		for (const entry of Object.values(loaded.index.casts)) {
			if (entry[2] && entry[3] !== null && !fidOf.has(entry[2])) {
				fidOf.set(entry[2], entry[3]);
			}
		}
	}

	let tagged = 0;
	const gone: string[] = [];
	for (const hash of missing) {
		const fid = fidOf.get(hash);
		if (fid === undefined) {
			console.error(`snapchain: no fid known for ${hash} — skipping`);
			continue;
		}
		try {
			const res = await fetch(
				`https://snap.farcaster.xyz:3381/v1/castById?fid=${fid}&hash=${hash}`,
				{ headers: { Accept: "application/json" } },
			);
			if (res.status === 404) {
				gone.push(hash);
				continue;
			}
			if (!res.ok) {
				console.error(`snapchain ${res.status} for ${hash}`);
				continue;
			}
			const msg = (await res.json()) as SnapMessage;
			if (!msg?.hash) continue;
			fidOf.set(normalizeHash(msg.hash), msg.data.fid);
			const parent = msg.data.castAddBody?.parentCastId;
			if (parent) {
				fidOf.set(normalizeHash(parent.hash), parent.fid);
			}
			await tagCasts([castFromBackupMessage(msg)], ctx);
			tagged += 1;
		} catch (error) {
			console.error(
				`snapchain fetch failed for ${hash}:`,
				error instanceof Error ? error.message : error,
			);
		}
	}
	if (gone.length > 0) await markCastsDeleted(gone, "not found upstream");
	return tagged;
};

const store = new S3Store(s3ConfigFromEnv());
const ctx = runtimeContext();

const snapshot = await loadIndex(store);
if (!snapshot) throw new Error("no index in bucket");
const index = snapshot.index;
console.log(`bucket index: ${Object.keys(index.casts).length} casts`);
console.log(
	`target parent in index before: ${index.casts[TARGET] !== undefined}`,
);

const before = new Set(await ctx.data.missingParentHashes());
console.log(`missing parent hashes before: ${before.size}`);

await ctx.data.deferCommits();

// --- 1. SQLite-only rows → bucket ---------------------------------------
const db = new Database("db/queue.db3", { readonly: true });
const rows = db.query("SELECT hash, data FROM casts").all() as {
	hash: string;
	data: string;
}[];
const sqliteDeleted = new Set(
	(db.query("SELECT hash FROM deleted_casts").all() as { hash: string }[]).map(
		(r) => r.hash,
	),
);
db.close();

const known = new Set(Object.keys(index.casts));
const toTag: Cast[] = [];
for (const row of rows) {
	const hash = normalizeHash(row.hash);
	if (known.has(hash) || sqliteDeleted.has(hash)) continue;
	try {
		const cast = JSON.parse(row.data) as Cast;
		if (!cast?.hash || !cast?.timestamp || !cast?.author) continue;
		toTag.push(cast);
	} catch {
		console.error(`skipping malformed sqlite row ${row.hash}`);
	}
}
console.log(`sqlite-only rows to tag: ${toTag.length}`);
for (const batch of chunk(toTag, 100)) await tagCasts(batch, ctx);

// --- 2. Upstream heal for still-missing parents --------------------------
const healed = await hydrateReferencedParents(5, ctx);
let stillMissing = await ctx.data.missingParentHashes();
console.log(`heal fetched: ${healed}, still missing: ${stillMissing.length}`);

// Snapchain fallback rounds for hashes haatz refuses; each landed hash can
// surface its own parent in the anti-join, so re-run the standard heal after.
for (let round = 0; round < 3 && stillMissing.length > 0; round++) {
	const snapTagged = await snapchainHeal(stillMissing);
	console.log(`snapchain round ${round + 1}: tagged ${snapTagged}`);
	if (snapTagged === 0) break;
	await hydrateReferencedParents(3, ctx);
	stillMissing = await ctx.data.missingParentHashes();
	console.log(
		`still missing after snapchain round ${round + 1}: ${stillMissing.length}`,
	);
}
const foundParents = [...before].filter(
	(h) => !stillMissing.includes(h) && index.casts[h] === undefined,
);
console.log(`parents newly available: ${foundParents.length}`);

// --- 3. Repair reply headers rendered while the parent was missing ------
// Header block is everything before the first "\n--\n" separator; when the
// parent lookup failed at render time it contains "](undefined)".
const foundSet = new Set(foundParents);
const sink = ctx.out("out");
let repaired = 0;
for (const [hash, entry] of Object.entries(index.casts)) {
	const parentHash = entry[2];
	const parentFid = entry[3];
	if (!parentHash || !foundSet.has(parentHash)) continue;

	const parentData = await ctx.data.getCastData(
		parentHash,
		parentFid ?? undefined,
	);
	if (!parentData) continue; // tombstoned upstream — nothing to link

	const username = index.users[String(entry[0])]?.username ?? "null";
	const filename = hash2filename(hash, new Date(entry[1]));
	const relPath = `${username}/${filename}`;
	const existing = await sink.read(relPath);
	if (existing === null) continue;
	const sep = existing.indexOf("\n--\n");
	if (sep < 0) continue;
	if (!existing.slice(0, sep).includes("](undefined)")) continue;

	const castData = await ctx.data.getCastData(hash, entry[0]);
	if (!castData) continue;
	const header = await renderReplyHeader(JSON.parse(castData) as Cast, ctx);
	await sink.write(relPath, `${header}${existing.slice(sep)}`);
	repaired += 1;
	console.log(`repaired reply header: ${relPath}`);
}
console.log(`repaired headers: ${repaired}`);

await ctx.data.flushCommits();

// --- Verify ---------------------------------------------------------------
const after = await loadIndex(store);
console.log(
	`bucket index after: ${Object.keys(after?.index.casts ?? {}).length} casts`,
);
console.log(
	`target parent in index after: ${after?.index.casts[TARGET] !== undefined}`,
);
console.log(
	`target parent object: ${(await store.get(`casts/${TARGET.replace(/^0x/, "")}.json`)) !== null}`,
);
