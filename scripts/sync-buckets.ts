/**
 * Offsite copy (MIGRATION.md §5.3): mirror the archive bucket into a second
 * bucket on any S3-compatible provider (R2, AWS, Tigris, Backblaze B2,
 * Garage). Replaces the versioning-based undo log — R2 has no versioning —
 * so run this on a schedule (e.g. nightly) after archiver runs.
 *
 *   # destination creds (any provider):
 *   TARGET_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
 *   TARGET_S3_BUCKET=nano-farchiver-offsite
 *   TARGET_S3_REGION=us-west-004
 *   TARGET_S3_ACCESS_KEY_ID=... TARGET_S3_SECRET_ACCESS_KEY=...
 *   bun scripts/sync-buckets.ts
 *
 * Skips objects whose ETag already matches (idempotent); copies everything
 * else. `--dry-run` reports the delta without writing.
 */

import { listAllKeys } from "../src/store/indexModel";
import { S3Store } from "../src/store/s3";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

const requireEnv = (key: string): string => {
	const value = process.env[key];
	if (!value) throw new Error(`missing ${key}`);
	return value;
};

const source = new S3Store({
	endpoint: requireEnv("S3_ENDPOINT"),
	bucket: requireEnv("S3_BUCKET"),
	region: process.env.S3_REGION ?? "auto",
	accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
	secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
});

const target = new S3Store({
	endpoint: requireEnv("TARGET_S3_ENDPOINT"),
	bucket: requireEnv("TARGET_S3_BUCKET"),
	region: process.env.TARGET_S3_REGION ?? "auto",
	accessKeyId: requireEnv("TARGET_S3_ACCESS_KEY_ID"),
	secretAccessKey: requireEnv("TARGET_S3_SECRET_ACCESS_KEY"),
});

const prefixes = [
	"casts/",
	"users/",
	"deleted/",
	"quotes/",
	"reactions/",
	"settings/",
	"fids/",
	"config/",
	"out/",
	"backups/",
	"meta/",
];

let copied = 0;
let skipped = 0;
let failed = 0;

for (const prefix of prefixes) {
	const keys = await listAllKeys(source, prefix);
	for (const key of keys) {
		const targetObj = await target.get(key);
		const sourceObj = await source.get(key);
		if (!sourceObj) continue;
		if (targetObj && targetObj.etag === sourceObj.etag) {
			skipped += 1;
			continue;
		}
		if (dryRun) {
			copied += 1;
			console.log(`would copy: ${key}`);
			continue;
		}
		try {
			await target.put(key, sourceObj.body);
			copied += 1;
		} catch (error) {
			failed += 1;
			console.error(`copy failed for ${key}:`, error);
		}
	}
	console.log(
		`${prefix} done (running totals: ${copied} copied, ${skipped} skipped, ${failed} failed)`,
	);
}

console.log(
	`sync ${dryRun ? "(dry run)" : "complete"}: ${copied} copied, ${skipped} skipped, ${failed} failed`,
);
if (failed > 0) process.exit(1);
