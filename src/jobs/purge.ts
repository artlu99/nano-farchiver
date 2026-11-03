import {
	FarcasterNetwork,
	hexStringToBytes,
	Message,
	makeCastRemove,
	makeReactionAdd,
	NobleEd25519Signer,
	ReactionType,
} from "@farcaster/core";
import invariant from "tiny-invariant";
import {
	backupMessage,
	checkpoint,
	type ManifestEntry,
	readBackupFiles,
	readManifest,
} from "../lib/backup";
import { ARCHIVER_FID, getPolicy } from "../lib/config";
import { getDb } from "../lib/db";
import { normalizeHash } from "../lib/helpers";
import type { SnapMessage } from "../lib/snapchain";
import {
	snapCastById,
	snapCastsByFid,
	snapHasReaction,
	snapOnChainSigners,
	snapReactionsByFid,
	snapSubmitMessage,
} from "../lib/snapchain";
import { checkpointMatchesManifest, gateFromDisk } from "../lib/verify";
import { markCastsDeleted } from "./read";

const FARCASTER_EPOCH_S = 1609459200;

export interface Candidate {
	hash: string;
	ts_iso: string;
	age_days: number;
	text_preview: string;
	backed_up: boolean;
	gate_ok?: boolean;
	gate_error?: string;
}

export interface ReactionSets {
	likes: Set<string>;
	recasts: Set<string>;
}

const signerPrivateKey = (): Uint8Array => {
	const raw = process.env.FARCASTER_SIGNER_PRIVATE_KEY?.replace(/^0x/, "");
	invariant(raw, "FARCASTER_SIGNER_PRIVATE_KEY is required for this operation");
	invariant(
		raw.length === 64,
		"FARCASTER_SIGNER_PRIVATE_KEY must be 32 bytes of hex",
	);
	return hexStringToBytes(raw)._unsafeUnwrap();
};

export const ageDaysOf = (message: SnapMessage): number | null => {
	const ts = message.data?.timestamp;
	if (!ts) return null;
	const unixMs = (ts + FARCASTER_EPOCH_S) * 1000;
	return (Date.now() - unixMs) / 86_400_000;
};

/**
 * Full like-set refresh — never incremental: unlikes are the delete signal.
 * Survivors get upserted; rows not touched this run are deleted (staleness =
 * an unlike). Returns the like/recast keep-sets (normalized hashes).
 */
export const refreshSelfReactions = async (): Promise<ReactionSets> => {
	const db = getDb();
	const startedAt = Date.now();
	const likes = new Set<string>();
	const recasts = new Set<string>();
	const upsert = db.prepare(
		"INSERT INTO self_reactions (target_hash, type, updated_at) VALUES (?, ?, ?) ON CONFLICT(target_hash, type) DO UPDATE SET updated_at = excluded.updated_at",
	);
	const collect = async (type: "Like" | "Recast", target: Set<string>) => {
		for (const msg of await snapReactionsByFid(ARCHIVER_FID, type)) {
			const targetHash = msg.data?.reactionBody?.targetCastId?.hash;
			if (!targetHash) continue;
			const normalized = normalizeHash(targetHash);
			target.add(normalized);
			upsert.run(normalized, type.toLowerCase(), startedAt);
		}
	};
	await collect("Like", likes);
	const recastKeeps = process.env.PURGE_RECAST_KEEPS === "1";
	if (recastKeeps) await collect("Recast", recasts);
	db.prepare("DELETE FROM self_reactions WHERE updated_at < ?").run(startedAt);
	console.log(
		`like-set: ${likes.size} like(s)${recastKeeps ? `, ${recasts.size} recast(s)` : ""}`,
	);
	return { likes, recasts };
};

export const fetchLiveCasts = async (): Promise<SnapMessage[]> =>
	snapCastsByFid(ARCHIVER_FID);

export const computeCandidates = (
	live: SnapMessage[],
	reactions: ReactionSets,
): { candidates: Candidate[]; liveHashes: string[] } => {
	const policy = getPolicy();
	const candidates: Candidate[] = [];
	const liveHashes: string[] = [];
	for (const msg of live) {
		const hash = normalizeHash(msg.hash ?? "");
		liveHashes.push(hash);
		if (reactions.likes.has(hash) || reactions.recasts.has(hash)) continue;
		if (isTombstoned(hash)) continue;
		const age = ageDaysOf(msg);
		if (age === null || age < policy.minAgeDays) continue;
		candidates.push({
			hash,
			ts_iso: msg.data.timestamp
				? new Date(
						(msg.data.timestamp + FARCASTER_EPOCH_S) * 1000,
					).toISOString()
				: "",
			age_days: Math.floor(age),
			text_preview: (msg.data.castAddBody?.text ?? "").slice(0, 120),
			backed_up: readBackupFiles(hash) !== null,
		});
	}
	return { candidates, liveHashes };
};

// Explicit db access here (read.ts's isCastDeleted has the same shape).
const isTombstoned = (hash: string): boolean =>
	!!getDb()
		.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
		.get(hash);

/**
 * Crash recovery, derived from protocol + tombstones + files:
 * finish (tombstoned+live+unliked ⇒ re-submit), release (tombstoned+live+liked ⇒
 * remove tombstone — protocol wins), settled (tombstoned+absent ⇒ no-op).
 */
export const applyResumeRules = async (
	liveHashes: string[],
	reactions: ReactionSets,
	live: boolean,
): Promise<{ finished: number; released: number }> => {
	const db = getDb();
	const liveSet = new Set(liveHashes);
	const tombstoned = db
		.query("SELECT hash FROM deleted_casts WHERE reason LIKE 'self-purge%'")
		.all() as { hash: string }[];
	let finished = 0;
	let released = 0;
	for (const { hash } of tombstoned) {
		const normalized = normalizeHash(hash);
		if (!liveSet.has(normalized)) continue; // settled
		if (reactions.likes.has(normalized) || reactions.recasts.has(normalized)) {
			db.prepare("DELETE FROM deleted_casts WHERE hash = ?").run(normalized);
			console.log(
				`resume: released ${normalized} (liked again — protocol wins)`,
			);
			released += 1;
			continue;
		}
		if (!live) {
			console.log(`resume: finish pending for ${normalized} (dry-run)`);
			continue;
		}
		if (!readBackupFiles(normalized)) {
			console.error(
				`resume: no backup for ${normalized} — skipping (should not happen)`,
			);
			continue;
		}
		await submitRemove(normalized);
		console.log(`resume: re-submitted delete for ${normalized}`);
		finished += 1;
	}
	return { finished, released };
};

export const signerDoctor = async (): Promise<{
	ok: boolean;
	pubkey?: string;
	error?: string;
}> => {
	try {
		const signer = new NobleEd25519Signer(signerPrivateKey());
		const keyResult = await signer.getSignerKey();
		if (keyResult.isErr()) return { ok: false, error: keyResult.error.message };
		const pubkey = Buffer.from(keyResult.value).toString("hex");
		const events = await snapOnChainSigners(ARCHIVER_FID);
		let latest: string | undefined;
		for (const event of events) {
			if (event.signerEventBody?.key?.toLowerCase() === pubkey) {
				latest = event.signerEventBody.eventType;
			}
		}
		if (latest === undefined) {
			return {
				ok: false,
				pubkey,
				error: "signer key not registered to this fid",
			};
		}
		if (latest !== "SIGNER_EVENT_TYPE_ADD") {
			return { ok: false, pubkey, error: `signer key state is ${latest}` };
		}
		return { ok: true, pubkey };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
};

const buildRemoveBytes = async (hash: string): Promise<Uint8Array> => {
	const signer = new NobleEd25519Signer(signerPrivateKey());
	const result = await makeCastRemove(
		{ targetHash: hexStringToBytes(normalizeHash(hash))._unsafeUnwrap() },
		{ fid: ARCHIVER_FID, network: FarcasterNetwork.MAINNET },
		signer,
	);
	if (result.isErr())
		throw new Error(`makeCastRemove failed: ${result.error.message}`);
	return Message.encode(result.value).finish();
};

const buildLikeBytes = async (hash: string): Promise<Uint8Array> => {
	const signer = new NobleEd25519Signer(signerPrivateKey());
	const result = await makeReactionAdd(
		{
			type: ReactionType.LIKE,
			targetCastId: {
				fid: ARCHIVER_FID,
				hash: hexStringToBytes(normalizeHash(hash))._unsafeUnwrap(),
			},
		},
		{ fid: ARCHIVER_FID, network: FarcasterNetwork.MAINNET },
		signer,
	);
	if (result.isErr())
		throw new Error(`makeReactionAdd failed: ${result.error.message}`);
	return Message.encode(result.value).finish();
};

export const submitRemove = async (hash: string): Promise<void> => {
	await snapSubmitMessage(await buildRemoveBytes(hash));
};

export const likeCast = async (hash: string): Promise<void> => {
	await snapSubmitMessage(await buildLikeBytes(hash));
};

const ensureLivePreconditions = async (): Promise<void> => {
	const doctor = await signerDoctor();
	if (!doctor.ok) {
		throw new Error(`signer doctor failed: ${doctor.error}`);
	}
	console.log(`signer doctor: ok (${doctor.pubkey})`);
	const gating = process.env.PURGE_REQUIRE_CHECKPOINT !== "0";
	try {
		const done = await checkpoint();
		console.log(
			`checkpoint: synced offsite via ${done.via} (${done.count} entries)`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (gating) {
			throw new Error(`auto-checkpoint failed: ${message}`);
		}
		console.warn(`auto-checkpoint failed (gating disabled): ${message}`);
	}
	if (gating) {
		const match = checkpointMatchesManifest();
		if (!match.ok) {
			throw new Error(`checkpoint gate: ${match.reason}`);
		}
	}
};

const submitDelete = async (hash: string): Promise<void> => {
	// Tombstone BEFORE submit — always. Crash-after-tombstone is resolved by
	// the finish resume rule; a crash the other way around would re-delete.
	await markCastsDeleted([hash], "self-purge (not liked by owner)");
	await submitRemove(hash);
};

export interface RunResult {
	dryRun: boolean;
	candidates: number;
	deleted: number;
	skipped: number;
	failed: number;
}

export const purgeRun = async (options: {
	live: boolean;
	batchN?: number;
}): Promise<RunResult> => {
	const { live, batchN } = options;
	const reactions = await refreshSelfReactions();
	const liveMsgs = await fetchLiveCasts();
	console.log(`live casts: ${liveMsgs.length}`);

	const { finished, released } = await applyResumeRules(
		liveMsgs.map((msg) => normalizeHash(msg.hash)),
		reactions,
		live,
	);

	const { candidates, liveHashes } = computeCandidates(liveMsgs, reactions);

	// Preflight containment: candidates ⊆ live ⊆ archive. castsByFid can list
	// phantom hashes (shard replica lag) — re-check each drifted hash via
	// castById; true 404s are tombstoned, still-live unarchived casts abort.
	const db = getDb();
	const drift = liveHashes.filter((hash) => {
		const row = db.query("SELECT 1 as one FROM casts WHERE hash = ?").get(hash);
		return !row;
	});
	const realDrift: string[] = [];
	for (const hash of drift) {
		const raw = await snapCastById(ARCHIVER_FID, hash);
		if (raw) {
			realDrift.push(hash);
		} else {
			await markCastsDeleted([hash], "not found upstream (preflight)");
			console.log(`preflight: phantom hash tombstoned ${hash}`);
		}
	}
	if (realDrift.length > 0) {
		throw new Error(
			`preflight: ${realDrift.length} live cast(s) not in local archive — run \`bun clear && bun doIt\` first (e.g. ${realDrift.slice(0, 3).join(", ")})`,
		);
	}

	const cap = batchN ?? Number(process.env.PURGE_MAX_BATCH ?? 50);
	const batch = candidates.slice(0, cap);
	console.log(
		`candidates: ${candidates.length} (batch ${batch.length}${live ? ", LIVE" : ", dry-run"})`,
	);

	const result: RunResult = {
		dryRun: !live,
		candidates: candidates.length,
		deleted: 0,
		skipped: 0,
		failed: 0,
	};

	if (live) await ensureLivePreconditions();

	const delayMs = Number(process.env.PURGE_DELAY_MS ?? 1000);
	for (const candidate of batch) {
		const gate = await gateFromDisk(candidate.hash);
		if (!gate.ok) {
			// No valid backup: back up now from the live message, then gate again.
			const raw = await snapCastById(ARCHIVER_FID, candidate.hash);
			if (!raw) {
				await markCastsDeleted([candidate.hash], "not found upstream");
				console.log(`gone upstream: ${candidate.hash}`);
				result.skipped += 1;
				continue;
			}
			backupMessage(raw);
			const regate = await gateFromDisk(candidate.hash);
			if (!regate.ok) {
				console.error(
					`gate FAILED for ${candidate.hash}: ${regate.error} — no delete`,
				);
				result.failed += 1;
				continue;
			}
			candidate.gate_ok = true;
		} else {
			candidate.gate_ok = true;
		}

		if (!live) {
			console.log(
				`would delete: ${candidate.hash} (${candidate.age_days}d, ${candidate.backed_up ? "backed up" : "backed up now"}) ${candidate.text_preview}`,
			);
			result.skipped += 1;
			continue;
		}

		// Age re-check against the CURRENT policy (mid-run changes apply);
		// age only grows between selection and here, so the stored value is the floor.
		const policy = getPolicy();
		if (candidate.age_days < policy.minAgeDays) {
			console.log(`skipped (age policy): ${candidate.hash}`);
			result.skipped += 1;
			continue;
		}

		// Fresh like re-check: a like added after the snapshot aborts this delete.
		if (await snapHasReaction(ARCHIVER_FID, candidate.hash, "Like")) {
			console.log(`skipped (liked since snapshot): ${candidate.hash}`);
			result.skipped += 1;
			continue;
		}

		try {
			await submitDelete(candidate.hash);
			result.deleted += 1;
			console.log(`deleted: ${candidate.hash}`);
		} catch (error) {
			result.failed += 1;
			const message = error instanceof Error ? error.message : String(error);
			if (/bad_request/.test(message)) {
				console.error(
					`permanent submit error for ${candidate.hash}: ${message}`,
				);
			} else {
				console.error(`submit error for ${candidate.hash}: ${message}`);
			}
		}
		if (delayMs > 0) await Bun.sleep(delayMs);
	}

	console.log(
		`done: ${result.deleted} deleted, ${result.skipped} skipped, ${result.failed} failed (resume: ${finished} finished, ${released} released)`,
	);
	return result;
};

export const backupAll = async (): Promise<{
	backed_up: number;
	already: number;
	failed: number;
}> => {
	const live = await fetchLiveCasts();
	console.log(`live casts: ${live.length}`);
	let backedUp = 0;
	let already = 0;
	let failed = 0;
	for (const msg of live) {
		const hash = normalizeHash(msg.hash ?? "");
		try {
			const existing = readBackupFiles(hash);
			if (!existing) {
				backupMessage(msg);
			}
			const gate = await gateFromDisk(hash);
			const entry: ManifestEntry | undefined = readManifest()
				.filter((e) => e.hash === hash)
				.at(-1);
			if (entry) {
				entry.verified = {
					hash: gate.checks.json_reencodes_to_bin,
					sig: gate.checks.ed25519_signature,
					signer_registered: gate.checks.signer_registered ?? false,
				};
			}
			if (gate.ok) {
				if (existing) already += 1;
				else backedUp += 1;
			} else {
				failed += 1;
				console.error(`gate failed for ${hash}: ${gate.error}`);
			}
		} catch (error) {
			failed += 1;
			console.error(
				`backup failed for ${hash}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	console.log(
		`backup:all: ${backedUp} new, ${already} existing, ${failed} failed`,
	);
	return { backed_up: backedUp, already, failed };
};

export const verifyBackups = async (
	sampleN?: number,
): Promise<{ ok: number; failed: number }> => {
	const entries = readManifest().filter((entry) => entry.fid === ARCHIVER_FID);
	const selected =
		sampleN && sampleN < entries.length
			? entries.filter((_, i) => i % Math.ceil(entries.length / sampleN) === 0)
			: entries;
	let ok = 0;
	let failed = 0;
	for (const entry of selected) {
		const gate = await gateFromDisk(entry.hash);
		if (gate.ok) {
			ok += 1;
		} else {
			failed += 1;
			console.error(`VERIFY FAILED ${entry.hash}: ${gate.error}`);
		}
	}
	console.log(
		`verify: ${ok} ok, ${failed} failed (of ${entries.length} manifest entries)`,
	);
	return { ok, failed };
};

// ---------------------------------------------------------------------------
// Review-UI helpers (imported by server.ts)
// ---------------------------------------------------------------------------

export const candidatesForReview = async (page: number, perPage: number) => {
	const all = await refreshCandidates();
	const start = (page - 1) * perPage;
	return {
		candidates: all.slice(start, start + perPage),
		page,
		total: all.length,
		total_pages: Math.max(1, Math.ceil(all.length / perPage)),
		policy: getPolicy(),
	};
};

export const deletedLedger = (page: number, perPage: number) => {
	const db = getDb();
	const total = (
		db.query("SELECT count(1) as n FROM deleted_casts").get() as { n: number }
	).n;
	const rows = db
		.query(
			"SELECT hash, deleted_at, reason FROM deleted_casts ORDER BY deleted_at DESC LIMIT ? OFFSET ?",
		)
		.all(perPage, (page - 1) * perPage) as {
		hash: string;
		deleted_at: number;
		reason: string;
	}[];
	return {
		deleted: rows.map((row) => ({
			...row,
			backed_up: readBackupFiles(row.hash) !== null,
		})),
		page,
		total,
		total_pages: Math.max(1, Math.ceil(total / perPage)),
	};
};

/** Live single-cast delete from the review UI: full gate, checkpoint, tombstone, submit. */
export const deleteOne = async (hash: string): Promise<void> => {
	await ensureLivePreconditions();
	const normalized = normalizeHash(hash);
	const raw = await snapCastById(ARCHIVER_FID, normalized);
	if (!raw) {
		await markCastsDeleted([normalized], "not found upstream");
		return;
	}
	if (!readBackupFiles(normalized)) backupMessage(raw);
	const gate = await gateFromDisk(normalized);
	if (!gate.ok) throw new Error(`gate failed: ${gate.error}`);
	await submitDelete(normalized);
};

/** Verify+backup up to `limit` candidates (review UI "Backup+verify all"). */
export const verifyAll = async (
	limit: number,
): Promise<{ verified: number; remaining: number; failed: number }> => {
	const all = await refreshCandidates(true);
	const unbacked = all.filter((c) => !c.backed_up);
	let verified = 0;
	let failed = 0;
	for (const candidate of unbacked.slice(0, limit)) {
		const raw = await snapCastById(ARCHIVER_FID, candidate.hash);
		if (!raw) continue;
		backupMessage(raw);
		const gate = await gateFromDisk(candidate.hash);
		if (gate.ok) verified += 1;
		else failed += 1;
	}
	return { verified, remaining: Math.max(0, unbacked.length - limit), failed };
};

/** Live batch delete for the review UI (honors PURGE_MAX_BATCH). */
export const purgeVerifiedBatch = async (): Promise<RunResult> =>
	purgeRun({ live: true });

// Review endpoints share a short-lived candidate snapshot so paging doesn't
// re-paginate the like-set on every request.
let candidatesCache: { at: number; candidates: Candidate[] } | null = null;
const CANDIDATES_TTL_MS = 5 * 60 * 1000;

export const refreshCandidates = async (
	force = false,
): Promise<Candidate[]> => {
	if (
		!force &&
		candidatesCache &&
		Date.now() - candidatesCache.at < CANDIDATES_TTL_MS
	) {
		return candidatesCache.candidates;
	}
	const reactions = await refreshSelfReactions();
	const liveMsgs = await fetchLiveCasts();
	const candidates = computeCandidates(liveMsgs, reactions).candidates;
	candidatesCache = { at: Date.now(), candidates };
	return candidates;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const printUsage = (): void => {
	console.log(`usage: bun src/jobs/purge.ts <subcommand>
  backup              full backup + gate of all live casts (no deletes)
  verify [--sample N] re-run the gate on manifest backups from disk
  checkpoint          offsite sync (git push / rsync) + CHECKPOINT.json
  run [--live [N]]    dry-run by default; --live [N] deletes N candidates`);
};

if (import.meta.main) {
	const sub = process.argv[2] ?? "";
	const rest = process.argv.slice(3);
	try {
		if (sub === "backup") {
			await backupAll();
		} else if (sub === "verify") {
			const sampleIdx = rest.indexOf("--sample");
			const sample = sampleIdx >= 0 ? Number(rest[sampleIdx + 1]) : undefined;
			const { ok, failed } = await verifyBackups(sample);
			process.exitCode = failed > 0 ? 1 : 0;
			void ok;
		} else if (sub === "checkpoint") {
			const done = await checkpoint();
			console.log(
				`checkpoint: ${done.count} entries via ${done.via} (sha ${done.manifest_sha256.slice(0, 12)}…)`,
			);
		} else if (sub === "run") {
			const liveIdx = rest.indexOf("--live");
			const live = liveIdx >= 0;
			let batchN: number | undefined;
			if (live) {
				const n = Number(rest[liveIdx + 1]);
				if (Number.isFinite(n) && n > 0) batchN = n;
			}
			await purgeRun({ live, batchN });
		} else {
			printUsage();
			process.exitCode = sub === "" ? 0 : 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
