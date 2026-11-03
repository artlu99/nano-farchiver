/**
 * One-time migration (MIGRATION.md §8): db/queue.db3 + out/ + backups/ → one
 * S3-compatible bucket (R2 primary). Idempotent — content is deterministic from
 * the local sources, so re-running is safe.
 *
 *   bun run import:s3 --dry-run            # full pipeline against MemoryStore, no network
 *   bun run import:s3                      # real upload (needs S3_* env, § R2 setup below)
 *   bun run import:s3 --only=casts,index   # subset: casts,users,deleted,settings,
 *                                          # reactions,fids,config,out,backups,index,verify
 *   bun run verify:s3                      # checks only
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { mapWithConcurrency } from "../src/lib/concurrency";
import { ARCHIVER_FID } from "../src/lib/config";
import { hash2filename, normalizeHash, quoteHashes } from "../src/lib/helpers";
import {
	type ArchiveIndex,
	castKey,
	deletedKey,
	embedsFingerprint,
	fidRegistryKey,
	getJSON,
	INDEX_KEY,
	listAllKeys,
	loadIndex,
	previewOf,
	reactionKey,
	settingKey,
	textfiltersKey,
	userKey,
} from "../src/store/indexModel";
import { MemoryStore } from "../src/store/memory";
import { S3Store, s3ConfigFromEnv } from "../src/store/s3";
import { type ArchiveStore, bytesToText } from "../src/store/types";

const R2_SETUP_HELP = `R2 setup (read-write token):
  1. wrangler r2 bucket create <bucket>   (or dashboard → R2 → Create bucket)
  2. dashboard → R2 → Manage API tokens → Create token: "Object Read & Write", scoped to the bucket
  3. add to .env:
       S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
       S3_BUCKET=<bucket>
       S3_REGION=auto
       S3_ACCESS_KEY_ID=<token access key>
       S3_SECRET_ACCESS_KEY=<token secret>
  4. bun run import:s3 --dry-run && bun run import:s3`;

// --- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlyArg = argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg?.slice("--only=".length).split(",");
const concurrency =
	Number(argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1]) ||
	10;
const want = (section: string): boolean => !only || only.includes(section);

// --- store ------------------------------------------------------------------

let store: ArchiveStore;
if (dryRun) {
	store = new MemoryStore();
	console.log("dry-run: writing to MemoryStore (no network)");
} else {
	try {
		store = new S3Store(s3ConfigFromEnv());
	} catch (error) {
		console.error(
			`${error instanceof Error ? error.message : String(error)}\n\n${R2_SETUP_HELP}`,
		);
		process.exit(1);
	}
}

// --- sources ----------------------------------------------------------------

const DB_PATH = "db/queue.db3";
if (!existsSync(DB_PATH)) {
	console.error(`no ${DB_PATH} — run the archiver first`);
	process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

interface CastRow {
	hash: string;
	fid: number;
	data: string;
	parent_fid: number | null;
	parent_hash: string | null;
}
interface UserRow {
	fid: number;
	username: string | null;
	displayName: string | null;
	avatar: string | null;
	bio: string | null;
}
interface DeletedRow {
	hash: string;
	deleted_at: number;
	reason: string;
}
interface SettingRow {
	key: string;
	value: string;
	updated_at: number | null;
}
interface ReactionRow {
	target_hash: string;
	type: string;
	updated_at: number | null;
}

const castRows = db
	.query("SELECT hash, fid, data, parent_fid, parent_hash FROM casts")
	.all() as CastRow[];
const userRows = db
	.query("SELECT fid, username, displayName, avatar, bio FROM users")
	.all() as UserRow[];
const deletedRows = db
	.query("SELECT hash, deleted_at, reason FROM deleted_casts")
	.all() as DeletedRow[];
const settingRows = db
	.query("SELECT key, value, updated_at FROM settings")
	.all() as SettingRow[];
const reactionRows = db
	.query("SELECT target_hash, type, updated_at FROM self_reactions")
	.all() as ReactionRow[];

const usernameByFid = new Map<number, string>();
for (const row of userRows) {
	if (row.username) usernameByFid.set(row.fid, row.username);
}

// reply counts keyed `${parentHash}|${parentFid}` — mirrors countReplies(hash, fid)
const replyCounts = new Map<string, number>();
for (const row of db
	.query(
		"SELECT parent_hash, parent_fid, count(1) as n FROM casts WHERE parent_hash IS NOT NULL GROUP BY parent_hash, parent_fid",
	)
	.all() as { parent_hash: string; parent_fid: number | null; n: number }[]) {
	replyCounts.set(
		`${normalizeHash(row.parent_hash)}|${row.parent_fid ?? ""}`,
		row.n,
	);
}

// parse each cast once: full object + timestamp, preview, quotes, embeds fingerprint
interface CastMeta {
	cast: Cast | null;
	tsMs: number;
	preview: string;
	quotes: string[];
	embedsFp: string;
}
const parsedCasts = new Map<string, CastMeta>();
for (const row of castRows) {
	const hash = normalizeHash(row.hash);
	let cast: Cast | null = null;
	try {
		cast = JSON.parse(row.data) as Cast;
	} catch {
		// malformed row — index entry degrades, object bytes still migrate verbatim
	}
	const tsMs = cast?.timestamp ? Date.parse(cast.timestamp) : Number.NaN;
	parsedCasts.set(hash, {
		cast,
		tsMs: Number.isFinite(tsMs) ? tsMs : 0,
		preview: previewOf(cast?.text ?? ""),
		quotes: cast ? [...new Set(quoteHashes(cast))] : [],
		embedsFp: embedsFingerprint(cast?.embeds),
	});
}

// --- build the task list ------------------------------------------------------

interface Task {
	key: string;
	data: string | Uint8Array;
	section: string;
}
const tasks: Task[] = [];

if (want("casts")) {
	for (const row of castRows) {
		tasks.push({
			key: castKey(normalizeHash(row.hash)),
			data: row.data,
			section: "casts",
		});
	}
}

if (want("users")) {
	for (const row of userRows) {
		tasks.push({
			key: userKey(row.fid),
			data: JSON.stringify({
				fid: row.fid,
				username: row.username,
				displayName: row.displayName,
				avatar: row.avatar,
				bio: row.bio,
			}),
			section: "users",
		});
	}
}

if (want("deleted")) {
	for (const row of deletedRows) {
		tasks.push({
			key: deletedKey(normalizeHash(row.hash)),
			data: JSON.stringify({ reason: row.reason, deleted_at: row.deleted_at }),
			section: "deleted",
		});
	}
}

if (want("settings")) {
	for (const row of settingRows) {
		tasks.push({
			key: settingKey(row.key),
			data: JSON.stringify({ value: row.value, updated_at: row.updated_at }),
			section: "settings",
		});
	}
}

if (want("reactions")) {
	for (const row of reactionRows) {
		tasks.push({
			key: reactionKey(ARCHIVER_FID, row.target_hash, row.type),
			data: JSON.stringify({ updated_at: row.updated_at }),
			section: "reactions",
		});
	}
}

if (want("fids")) {
	tasks.push({
		key: fidRegistryKey(ARCHIVER_FID),
		data: JSON.stringify({
			fid: ARCHIVER_FID,
			username: usernameByFid.get(ARCHIVER_FID) ?? null,
			active: true,
			addedAt: Date.now(),
		}),
		section: "fids",
	});
}

if (want("config") && existsSync("db/textfilters.jsonl")) {
	tasks.push({
		key: textfiltersKey,
		data: new Uint8Array(readFileSync("db/textfilters.jsonl")),
		section: "config",
	});
}

const walkFiles = (dir: string): string[] => {
	const files: string[] = [];
	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, dirent.name);
		if (dirent.isDirectory()) files.push(...walkFiles(path));
		else files.push(path);
	}
	return files;
};

if (want("out") && existsSync("out")) {
	for (const path of walkFiles("out")) {
		const key = `out/${path.slice("out/".length)}`;
		tasks.push({
			key,
			data: new Uint8Array(readFileSync(path)),
			section: "out",
		});
	}
}

if (want("backups") && existsSync("backups")) {
	for (const path of walkFiles("backups")) {
		const key = `backups/${path.slice("backups/".length)}`;
		tasks.push({
			key,
			data: new Uint8Array(readFileSync(path)),
			section: "backups",
		});
	}
}

if (want("index")) {
	const index: ArchiveIndex = {
		version: 1,
		updatedAt: Date.now(),
		casts: {},
		deleted: {},
		quotes: {},
		users: {},
		fids: {},
		rendered: {},
	};
	for (const row of castRows) {
		const hash = normalizeHash(row.hash);
		const meta = parsedCasts.get(hash);
		if (!meta) continue;
		const replies = replyCounts.get(`${hash}|${row.fid}`) ?? 0;
		index.casts[hash] = [
			row.fid,
			meta.tsMs,
			row.parent_hash ? normalizeHash(row.parent_hash) : null,
			row.parent_fid ?? null,
			replies,
			meta.preview,
		];
		if (meta.quotes.length > 0) index.quotes[hash] = meta.quotes;
		index.users[String(row.fid)] = {
			username: usernameByFid.get(row.fid) ?? null,
		};
		// skip-if-rendered entries: record only casts that already have an out/ file
		const username =
			usernameByFid.get(row.fid) ?? meta.cast?.author?.username ?? null;
		const filename = meta.cast?.timestamp
			? hash2filename(hash, meta.cast.timestamp)
			: null;
		if (username && filename && existsSync(join("out", username, filename))) {
			const rendered = index.rendered[username] ?? {};
			rendered[filename] = { embedsFp: meta.embedsFp, replyCount: replies };
			index.rendered[username] = rendered;
		}
	}
	for (const row of deletedRows) {
		index.deleted[normalizeHash(row.hash)] = [row.reason, row.deleted_at];
	}
	index.fids[String(ARCHIVER_FID)] = {
		active: true,
		username: usernameByFid.get(ARCHIVER_FID) ?? null,
		lastRunAt: Date.now(),
	};
	const renderedCount = Object.values(index.rendered).reduce(
		(sum, files) => sum + Object.keys(files).length,
		0,
	);
	console.log(
		`  index: ${Object.keys(index.casts).length} casts, ${Object.keys(index.users).length} users, ` +
			`${Object.keys(index.deleted).length} tombstones, ${Object.keys(index.quotes).length} quoted, ` +
			`${renderedCount} rendered`,
	);
	tasks.push({
		key: INDEX_KEY,
		data: JSON.stringify(index),
		section: "index",
	});
}

// --- upload -------------------------------------------------------------------

const sectionCounts = new Map<string, number>();
for (const task of tasks) {
	sectionCounts.set(task.section, (sectionCounts.get(task.section) ?? 0) + 1);
}
console.log(
	`plan: ${tasks.length} object(s) → ${dryRun ? "MemoryStore" : s3ConfigFromEnv().bucket}`,
);
for (const [section, count] of [...sectionCounts.entries()].sort()) {
	console.log(`  ${section.padEnd(9)} ${count}`);
}

const startedAt = Date.now();
let done = 0;
await mapWithConcurrency(tasks, concurrency, async (task) => {
	await store.put(task.key, task.data);
	done += 1;
	if (done % 500 === 0) console.log(`  ${done}/${tasks.length}`);
});
console.log(
	`upload: ${done} object(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
);

// --- verify -------------------------------------------------------------------

if (!want("verify")) process.exit(0);

const taskPrefixes: Record<string, string> = {
	casts: "casts/",
	users: "users/",
	deleted: "deleted/",
	settings: "settings/",
	reactions: "reactions/",
	fids: "fids/",
	config: "config/",
	out: "out/",
	backups: "backups/",
	index: "meta/",
};

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	const suffix = ok ? "" : detail ? ` — ${detail}` : "";
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`);
	if (!ok) failures += 1;
};

const verifyOnly = only?.includes("verify") === true;

// Expected counts come from local sources, so `verify:s3` works both right
// after an upload and standalone against a bucket that already has the data.
const expectedCounts: Record<string, number> = {
	casts: castRows.length,
	users: userRows.length,
	deleted: deletedRows.length,
	settings: settingRows.length,
	reactions: reactionRows.length,
	fids: 1,
	config: existsSync("db/textfilters.jsonl") ? 1 : 0,
	out: existsSync("out") ? walkFiles("out").length : 0,
	backups: existsSync("backups") ? walkFiles("backups").length : 0,
	index: 1,
};
const sectionsToCheck =
	verifyOnly && sectionCounts.size === 0
		? Object.keys(taskPrefixes)
		: [...sectionCounts.keys()];

// 1. object counts per prefix vs local sources
for (const section of sectionsToCheck.sort()) {
	const prefix = taskPrefixes[section];
	if (!prefix) continue;
	const keys = await listAllKeys(store, prefix);
	const expected = sectionCounts.get(section) ?? expectedCounts[section] ?? 0;
	check(
		`${section} count`,
		keys.length === expected,
		`${keys.length} != ${expected}`,
	);
}

// 2. verbatim cast bytes (deterministic sample: first 3 + spread of 7)
const sampleRows = [
	...castRows.slice(0, 3),
	...[0, 1, 2, 3, 4, 5, 6]
		.map((i) => castRows[Math.floor((castRows.length / 7) * i)])
		.filter((r): r is CastRow => r !== undefined),
];
for (const row of sampleRows) {
	const hash = normalizeHash(row.hash);
	const obj = await store.get(castKey(hash));
	check(
		`cast ${hash.slice(0, 10)} bytes`,
		obj !== null && bytesToText(obj.body) === row.data,
	);
}

// 3. index sanity
const loaded = await loadIndex(store);
if (want("index") || verifyOnly) {
	check("index present", loaded !== null);
	const castsCount = loaded?.index
		? Object.keys(loaded.index.casts).length
		: -1;
	check(
		"index casts count",
		castsCount === castRows.length,
		`${castsCount} vs ${castRows.length}`,
	);
	const deletedCount = loaded?.index
		? Object.keys(loaded.index.deleted).length
		: -1;
	check("index deleted count", deletedCount === deletedRows.length);
}

// 4. conditional-write probe — proves If-Match works on the target provider
//    (R2/AWS yes; advisory check-then-put only on Tigris/B2/Garage, §3.1)
if (!dryRun) {
	const probe = `meta/.probe-${Date.now()}`;
	const created = await store.put(probe, "v1", { ifNoneMatch: "*" });
	let rejected = false;
	try {
		await store.put(probe, "v2", { ifMatch: "bogus-etag" });
	} catch (error) {
		rejected =
			error instanceof Error && error.name === "PreconditionFailedError";
	}
	await store.put(probe, "v3", { ifMatch: created.etag });
	await store.deleteKey(probe);
	check(
		"conditional PUT probe",
		rejected,
		rejected
			? "If-Match enforced"
			: "provider did NOT reject stale If-Match (advisory mode)",
	);
}

// 5. JSON roundtrip via getJSON
if ((want("users") || verifyOnly) && userRows[0]) {
	const user = await getJSON<{ fid: number }>(store, userKey(userRows[0].fid));
	check("getJSON users", user?.fid === userRows[0].fid);
}

if (failures > 0) {
	console.error(`verify: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("verify: all checks passed");
