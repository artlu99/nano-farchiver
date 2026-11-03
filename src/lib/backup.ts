import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fromFarcasterTime, Message, MessageData } from "@farcaster/core";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { cluster } from "radash";
import { getCastFromHash } from "../jobs/read";
import { renderCast } from "../jobs/write";
import { ARCHIVER_FID } from "./config";
import { getDb } from "./db";
import { hash2filename, normalizeHash } from "./helpers";
import {
	renderEmbedsAsync,
	renderReplyFooter,
	renderReplyHeader,
	renderTopLevelHeader,
} from "./markdown";
import { getCasts } from "./neynar";
import type { SnapMessage } from "./snapchain";

// backups/ deliberately lives OUTSIDE db/ — `bun clean` must never touch it.
const backupsDir = (): string => process.env.BACKUPS_DIR ?? "backups";
const manifestPath = (): string => join(backupsDir(), "manifest.jsonl");
const checkpointPath = (): string => join(backupsDir(), "CHECKPOINT.json");

export interface ManifestEntry {
	hash: string;
	fid: number;
	ts_farcaster: number;
	ts_iso: string;
	text_preview: string;
	data_sha256: string;
	signature: string;
	signer: string;
	verified: { hash: boolean; sig: boolean; signer_registered: boolean };
	backed_up_at: number;
	file: string;
}

export interface Checkpoint {
	manifest_sha256: string;
	count: number;
	synced_at: number;
	via: string;
}

export const sha256Hex = (bytes: Uint8Array): string =>
	createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** Re-encode the gateway's decoded MessageData JSON into the canonical hash-preimage bytes. */
export const messageDataBytes = (msg: SnapMessage): Uint8Array =>
	MessageData.encode(
		MessageData.fromJSON(msg.data as unknown as Record<string, unknown>),
	).finish();

export const messageBytes = (msg: unknown): Uint8Array =>
	Message.encode(msg as Parameters<typeof Message.encode>[0]).finish();

const ensureDir = (): void => {
	mkdirSync(backupsDir(), { recursive: true });
};

const hashFilename = (hash: string): string =>
	normalizeHash(hash).replace(/^0x/, "");

export const backupBinPath = (hash: string): string =>
	join(backupsDir(), `${hashFilename(hash)}.bin`);
export const backupJsonPath = (hash: string): string =>
	join(backupsDir(), `${hashFilename(hash)}.json`);

export const hasBackupFiles = (hash: string): boolean =>
	existsSync(backupBinPath(hash)) && existsSync(backupJsonPath(hash));

export const readBackupFiles = (
	hash: string,
): { bin: Uint8Array; json: SnapMessage } | null => {
	if (!hasBackupFiles(hash)) return null;
	const bin = readFileSync(backupBinPath(hash));
	const json = JSON.parse(
		readFileSync(backupJsonPath(hash), "utf-8"),
	) as SnapMessage;
	return { bin: new Uint8Array(bin), json };
};

export const readManifest = (): ManifestEntry[] => {
	if (!existsSync(manifestPath())) return [];
	const lines = readFileSync(manifestPath(), "utf-8")
		.split("\n")
		.filter(Boolean);
	return lines.map((line) => JSON.parse(line) as ManifestEntry);
};

const manifestHashes = (): Set<string> =>
	new Set(readManifest().map((entry) => entry.hash));

export const manifestSha256 = (): string => {
	if (!existsSync(manifestPath())) {
		return createHash("sha256").update("").digest("hex");
	}
	return sha256Hex(new Uint8Array(readFileSync(manifestPath())));
};

/**
 * Persist a gateway message as the canonical artifact pair + manifest line.
 * Idempotent: existing backups are left untouched (content-addressed by hash).
 */
export const backupMessage = (msg: SnapMessage): ManifestEntry => {
	const hash = normalizeHash(msg.hash);
	ensureDir();
	const bytes = messageDataBytes(msg);
	const existing = manifestHashes();
	if (hasBackupFiles(hash) && existing.has(hash)) {
		const entry = readManifest().find((e) => e.hash === hash);
		if (entry) return entry;
	}
	writeFileSync(backupBinPath(hash), Buffer.from(bytes));
	writeFileSync(backupJsonPath(hash), JSON.stringify(msg, null, "\t"));
	const dataSha256 = sha256Hex(bytes);
	const farcasterTs = msg.data?.timestamp ?? 0;
	const tsResult = fromFarcasterTime(farcasterTs);
	const unixMs = tsResult.isOk() ? tsResult.value : undefined;
	const entry: ManifestEntry = {
		hash,
		fid: msg.data?.fid ?? 0,
		ts_farcaster: farcasterTs,
		ts_iso: unixMs ? new Date(unixMs).toISOString() : "",
		text_preview: (msg.data?.castAddBody?.text ?? "").slice(0, 120),
		data_sha256: dataSha256,
		signature: msg.signature ?? "",
		signer: msg.signer ?? "",
		verified: { hash: false, sig: false, signer_registered: false },
		backed_up_at: Date.now(),
		file: `${hashFilename(hash)}.bin`,
	};
	if (!existing.has(hash)) {
		appendFileSync(manifestPath(), `${JSON.stringify(entry)}\n`);
	}
	return entry;
};

/** Update the `verified` flags on an existing manifest entry (last line wins on re-read). */
export const markManifestVerified = (
	hash: string,
	verified: ManifestEntry["verified"],
): void => {
	const entries = readManifest();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry && entry.hash === normalizeHash(hash)) {
			entry.verified = verified;
			break;
		}
	}
	ensureDir();
	writeFileSync(
		manifestPath(),
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
};

export const writeCheckpoint = (): Checkpoint => {
	ensureDir();
	const checkpoint: Checkpoint = {
		manifest_sha256: manifestSha256(),
		count: readManifest().length,
		synced_at: Date.now(),
		via: "pending-sync",
	};
	writeFileSync(checkpointPath(), JSON.stringify(checkpoint, null, "\t"));
	return checkpoint;
};

export const readCheckpoint = (): Checkpoint | null => {
	if (!existsSync(checkpointPath())) return null;
	try {
		return JSON.parse(readFileSync(checkpointPath(), "utf-8")) as Checkpoint;
	} catch {
		return null;
	}
};

/**
 * Offsite sync: git commit + push of backups/ (preferred), or rsync to
 * BACKUP_RSYNC_TARGET. Returns the transport used. Throws on failure —
 * live purge runs must not proceed without an offsite copy.
 */
export const syncOffsite = async (): Promise<string> => {
	const msg = `backup checkpoint: ${readManifest().length} casts @ ${new Date().toISOString()}`;
	const gitDir = resolve(".git");
	if (existsSync(gitDir)) {
		const remotes = await Bun.$`git remote`.nothrow().quiet();
		const hasRemote =
			remotes.exitCode === 0 && remotes.stdout.toString().trim().length > 0;
		if (hasRemote) {
			await Bun.$`git add ${backupsDir()}`.quiet();
			const commit = await Bun.$`git commit -m ${msg}`.nothrow().quiet();
			if (commit.exitCode !== 0) {
				const out = commit.stderr.toString();
				if (!out.includes("nothing to commit")) {
					throw new Error(`git commit failed: ${out.slice(0, 300)}`);
				}
			}
			const push = await Bun.$`git push`.nothrow().quiet();
			if (push.exitCode !== 0) {
				throw new Error(
					`git push failed: ${push.stderr.toString().slice(0, 300)}`,
				);
			}
			return "git";
		}
	}
	const rsyncTarget = process.env.BACKUP_RSYNC_TARGET;
	if (rsyncTarget) {
		const sync =
			await Bun.$`rsync -a ${backupsDir().replace(/\/$/, "")}/ ${rsyncTarget}`
				.nothrow()
				.quiet();
		if (sync.exitCode !== 0) {
			throw new Error(`rsync failed: ${sync.stderr.toString().slice(0, 300)}`);
		}
		return "rsync";
	}
	throw new Error(
		"no offsite target: configure a git remote or BACKUP_RSYNC_TARGET (or set PURGE_REQUIRE_CHECKPOINT=0 to consciously accept single-copy risk)",
	);
};

export const checkpoint = async (): Promise<Checkpoint> => {
	const checkpointState = writeCheckpoint();
	const via = await syncOffsite();
	const done: Checkpoint = { ...checkpointState, via };
	writeFileSync(checkpointPath(), JSON.stringify(done, null, "\t"));
	return done;
};

/**
 * Build a minimal Neynar-Cast-shaped object from a backed-up gateway message,
 * for re-inserting purged casts into the archive (self-heal). Best-effort:
 * text, parent, embeds, hash, timestamp survive; mention profiles need hydration.
 */
export const castFromBackupMessage = (msg: SnapMessage): Cast => {
	const body = msg.data.castAddBody ?? {};
	const tsResult = fromFarcasterTime(msg.data.timestamp);
	const unixMs = tsResult.isOk() ? tsResult.value : undefined;
	return {
		hash: normalizeHash(msg.hash),
		thread_hash: normalizeHash(msg.hash),
		timestamp: unixMs
			? new Date(unixMs).toISOString()
			: new Date(0).toISOString(),
		text: body.text ?? "",
		author: { fid: msg.data.fid },
		parent_hash: body.parentCastId?.hash,
		parent_author: body.parentCastId
			? { fid: body.parentCastId.fid }
			: undefined,
		embeds: (body.embeds ?? []).map((embed) =>
			"url" in embed && embed.url
				? { url: embed.url }
				: "castId" in embed && embed.castId
					? { cast_id: { hash: embed.castId.hash, fid: embed.castId.fid } }
					: {},
		),
	} as unknown as Cast;
};

/**
 * Always-on archive self-heal (post-`bun clean`, or pre-warmed backups):
 * for every manifest entry of ARCHIVER_FID missing from `casts`, re-insert it.
 * Live casts come back via the normal Neynar fetch path; purged casts are
 * rebuilt from the backup proto and rendered directly into out/ (they are
 * tombstoned, so castsLoop skips them — the file is written here, once).
 */
export const selfHealFromBackups = async (outDir = "out"): Promise<number> => {
	const entries = readManifest().filter((entry) => entry.fid === ARCHIVER_FID);
	if (entries.length === 0) return 0;
	const missing: ManifestEntry[] = [];
	for (const entry of entries) {
		if (!(await getCastFromHash(entry.hash, undefined))) missing.push(entry);
	}
	if (missing.length === 0) return 0;
	console.log(
		`self-heal: ${missing.length} manifest-backed cast(s) missing from archive`,
	);

	// Live casts: existing Neynar path inserts the row (and auto-tombstones absent ones).
	const unfetched = missing.filter((entry) => !isTombstoned(entry.hash));
	for (const chunk of cluster(
		unfetched.map((entry) => entry.hash),
		25,
	)) {
		await getCasts(chunk ?? []);
	}

	// Purged casts: rebuild from the backup proto and render once.
	let healed = 0;
	for (const entry of missing) {
		if (await getCastFromHash(entry.hash, undefined)) continue; // live path succeeded
		const backup = readBackupFiles(entry.hash);
		if (!backup) {
			console.error(
				`self-heal: no backup on disk for ${entry.hash} — skipping`,
			);
			continue;
		}
		const cast = castFromBackupMessage(backup.json);
		insertHealedRow(entry, cast);
		await renderHealedFile(entry, cast, outDir);
		healed += 1;
	}
	if (healed > 0)
		console.log(`self-heal: rebuilt ${healed} purged cast(s) from backups/`);
	return healed;
};

const isTombstoned = (hash: string): boolean =>
	!!getDb()
		.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
		.get(normalizeHash(hash));

const insertHealedRow = (entry: ManifestEntry, cast: Cast): void => {
	const db = getDb();
	db.prepare(
		"INSERT INTO casts (hash, fid, data, parent_fid, parent_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
	).run(
		normalizeHash(entry.hash),
		cast.author?.fid ?? entry.fid,
		JSON.stringify(cast),
		cast.parent_author?.fid,
		cast.parent_hash ? normalizeHash(cast.parent_hash) : null,
	);
	if (!isTombstoned(entry.hash)) {
		db.prepare(
			"INSERT OR IGNORE INTO deleted_casts (hash, deleted_at, reason) VALUES (?, ?, ?)",
		).run(normalizeHash(entry.hash), Date.now(), "restored from backup");
	}
};

const renderHealedFile = async (
	entry: ManifestEntry,
	cast: Cast,
	healOutDir = "out",
): Promise<void> => {
	const username = getUsername(entry.fid);
	const userDir = resolve(healOutDir, username);
	mkdirSync(userDir, { recursive: true });
	const path = join(userDir, hash2filename(entry.hash, cast.timestamp));
	if (existsSync(path)) return; // never rewrite
	const rendered = await renderCast(cast);
	const replyCount = countHealedReplies(entry.hash);
	const embedBlock = await renderEmbedsAsync(cast.embeds ?? []);
	const body = [
		rendered.parent_hash
			? await renderReplyHeader(cast)
			: await renderTopLevelHeader(cast),
		"--",
		rendered.text + (embedBlock ? `\n\n${embedBlock}` : ""),
		renderReplyFooter(replyCount),
	].join("\n");
	writeFileSync(path, body.trim());
};

const getUsername = (fid: number): string => {
	const user = getDb()
		.query("SELECT username FROM users WHERE fid = ?")
		.get(fid) as { username: string | null } | undefined;
	return user?.username ?? `fid:${fid}`;
};

const countHealedReplies = (hash: string): number => {
	const row = getDb()
		.query("SELECT count(1) as count FROM casts WHERE parent_hash = ?")
		.get(normalizeHash(hash)) as { count: number } | undefined;
	return row?.count ?? 0;
};
