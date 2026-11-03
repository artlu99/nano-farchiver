import type { Database as SqliteDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519, hexStringToBytes } from "@farcaster/core";
import type { SnapMessage } from "../lib/snapchain";
import {
	buildSignedSnapMessage,
	makeReactionMessage,
	type SignedFixture,
} from "../test/purgeFixtures";

process.env.PURGE_MIN_AGE_DAYS = "7";

const backupDir = mkdtempSync(join(tmpdir(), "farchiver-purge-backups-"));
process.env.BACKUPS_DIR = backupDir;
process.env.FARCASTER_SIGNER_PRIVATE_KEY = "ab".repeat(32);

const fixtureOld: SignedFixture = await buildSignedSnapMessage({
	text: "old unliked",
	ageDays: 30,
});
const fixtureLiked: SignedFixture = await buildSignedSnapMessage({
	text: "old liked",
	ageDays: 30,
});
const fixtureYoung: SignedFixture = await buildSignedSnapMessage({
	text: "young",
	ageDays: 1,
});

const doctorPubkey = async (): Promise<string> => {
	const seed = hexStringToBytes(
		process.env.FARCASTER_SIGNER_PRIVATE_KEY ?? "",
	)._unsafeUnwrap();
	const result = await ed25519.getPublicKey(seed);
	return Buffer.from(result._unsafeUnwrap()).toString("hex");
};

// db handle is filled in after the dynamic import below; the submit spy reads
// the tombstone table at call time to prove tombstone-before-submit ordering.
let db: SqliteDatabase | null = null;

const snapchainMock = {
	castsByFid: [] as SnapMessage[],
	reactions: [] as SnapMessage[],
	castByIdResult: null as SnapMessage | null,
	hasReaction: false,
	submitCalls: [] as { tombstonePresentAtSubmit: boolean | null }[],
	submitHash: null as string | null,
};

const addEvent = (key: string) => ({
	type: "EVENT_TYPE_SIGNER",
	blockNumber: 1,
	signerEventBody: { key, keyType: 1, eventType: "SIGNER_EVENT_TYPE_ADD" },
});

mock.module("../lib/snapchain", () => ({
	snapCastsByFid: async () => snapchainMock.castsByFid,
	snapReactionsByFid: async () => snapchainMock.reactions,
	snapCastById: async () => snapchainMock.castByIdResult,
	snapHasReaction: async () => snapchainMock.hasReaction,
	snapOnChainSigners: async () => [
		addEvent(fixtureOld.signerHex),
		addEvent(fixtureLiked.signerHex),
		addEvent(fixtureYoung.signerHex),
		addEvent(await doctorPubkey()),
	],
	snapSubmitMessage: async () => {
		let tombstonePresentAtSubmit: boolean | null = null;
		if (snapchainMock.submitHash && db) {
			const row = db
				.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
				.get(snapchainMock.submitHash);
			tombstonePresentAtSubmit = !!row;
		}
		snapchainMock.submitCalls.push({ tombstonePresentAtSubmit });
	},
	traverse: async () => [],
	getCastsByParent: async () => [],
}));

mock.module("../lib/neynar", () => ({
	getCasts: async () => [],
	getCronFeed: async () => ({ casts: [] }),
	getReplies: async () => ({ casts: [] }),
	getConversation: async () => ({
		conversation: { cast: {}, chronological_parent_casts: [] },
	}),
}));

const dbModule = await import("../lib/db");
db = dbModule.getDb();
const {
	applyResumeRules,
	computeCandidates,
	purgeRun,
	refreshSelfReactions,
	signerDoctor,
} = await import("./purge");
const { backupMessage, readBackupFiles, selfHealFromBackups } = await import(
	"../lib/backup"
);
const { markCastsDeleted } = await import("./read");

beforeEach(() => {
	dbModule.initDb(":memory:");
	db = dbModule.getDb();
	snapchainMock.castsByFid = [];
	snapchainMock.reactions = [];
	snapchainMock.castByIdResult = null;
	snapchainMock.hasReaction = false;
	snapchainMock.submitCalls = [];
	snapchainMock.submitHash = null;
});

describe("computeCandidates", () => {
	test("live − likes − tombstones − too-young", () => {
		process.env.PURGE_MIN_AGE_DAYS = "7";
		snapchainMock.castsByFid = [
			fixtureOld.snap,
			fixtureLiked.snap,
			fixtureYoung.snap,
		];
		const reactions = {
			likes: new Set([fixtureLiked.hashHex]),
			recasts: new Set<string>(),
		};
		const { candidates, liveHashes } = computeCandidates(
			snapchainMock.castsByFid,
			reactions,
		);
		expect(liveHashes.length).toBe(3);
		expect(candidates.map((c) => c.hash)).toEqual([fixtureOld.hashHex]);
	});

	test("tombstoned hashes are not candidates", async () => {
		await markCastsDeleted(
			[fixtureOld.hashHex],
			"self-purge (not liked by owner)",
		);
		const { candidates } = computeCandidates([fixtureOld.snap], {
			likes: new Set(),
			recasts: new Set(),
		});
		expect(candidates.length).toBe(0);
	});
});

describe("refreshSelfReactions", () => {
	test("upserts current likes and deletes stale rows (an unlike is the delete signal)", async () => {
		const raw = db as unknown as SqliteDatabase;
		raw
			.prepare(
				"INSERT INTO self_reactions (target_hash, type, updated_at) VALUES (?, 'like', 1)",
			)
			.run("0xstale");
		snapchainMock.reactions = [makeReactionMessage(fixtureLiked.hashHex)];
		const { likes } = await refreshSelfReactions();
		expect(likes.has(fixtureLiked.hashHex)).toBe(true);
		expect(
			raw
				.query("SELECT 1 as one FROM self_reactions WHERE target_hash = ?")
				.get("0xstale"),
		).toBeFalsy();
		expect(
			raw
				.query("SELECT 1 as one FROM self_reactions WHERE target_hash = ?")
				.get(fixtureLiked.hashHex),
		).toBeDefined();
	});
});

describe("applyResumeRules", () => {
	test("release: tombstoned + live + liked ⇒ tombstone removed (protocol wins)", async () => {
		markCastsDeleted([fixtureLiked.hashHex], "self-purge (not liked by owner)");
		const { released } = await applyResumeRules(
			[fixtureLiked.hashHex],
			{ likes: new Set([fixtureLiked.hashHex]), recasts: new Set() },
			false,
		);
		expect(released).toBe(1);
		const row = (db as unknown as SqliteDatabase)
			.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
			.get(fixtureLiked.hashHex);
		expect(row).toBeFalsy();
	});

	test("finish (dry-run): tombstoned + live + unliked ⇒ reported, not submitted", async () => {
		markCastsDeleted([fixtureOld.hashHex], "self-purge (not liked by owner)");
		const { finished } = await applyResumeRules(
			[fixtureOld.hashHex],
			{ likes: new Set(), recasts: new Set() },
			false,
		);
		expect(finished).toBe(0);
		expect(snapchainMock.submitCalls.length).toBe(0);
	});

	test("finish (live): tombstoned + live + unliked ⇒ re-submitted", async () => {
		markCastsDeleted([fixtureOld.hashHex], "self-purge (not liked by owner)");
		backupMessage(fixtureOld.snap);
		const { finished } = await applyResumeRules(
			[fixtureOld.hashHex],
			{ likes: new Set(), recasts: new Set() },
			true,
		);
		expect(finished).toBe(1);
		expect(snapchainMock.submitCalls.length).toBe(1);
	});

	test("settled: tombstoned + absent from live ⇒ no-op", async () => {
		markCastsDeleted([fixtureOld.hashHex], "self-purge (not liked by owner)");
		const { finished, released } = await applyResumeRules(
			[],
			{ likes: new Set(), recasts: new Set() },
			false,
		);
		expect(finished).toBe(0);
		expect(released).toBe(0);
	});
});

describe("signerDoctor", () => {
	test("accepts a key whose latest registry event is ADD", async () => {
		const doctor = await signerDoctor();
		expect(doctor.ok).toBe(true);
		expect(doctor.pubkey).toBe(await doctorPubkey());
	});
});

describe("purgeRun", () => {
	const seedArchivedRow = (fixture: SignedFixture) => {
		(db as unknown as SqliteDatabase)
			.prepare(
				"INSERT INTO casts (hash, fid, data) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
			)
			.run(
				fixture.hashHex,
				3319217,
				JSON.stringify({ hash: fixture.hashHex, text: "x" }),
			);
	};

	test("dry-run: gates + reports, never submits", async () => {
		process.env.PURGE_MIN_AGE_DAYS = "7";
		snapchainMock.castsByFid = [fixtureOld.snap];
		seedArchivedRow(fixtureOld);
		const result = await purgeRun({ live: false });
		expect(result.dryRun).toBe(true);
		expect(result.candidates).toBe(1);
		expect(result.deleted).toBe(0);
		expect(snapchainMock.submitCalls.length).toBe(0);
	});

	test("live: backup → gate → tombstone → submit, in that order", async () => {
		process.env.PURGE_MIN_AGE_DAYS = "7";
		process.env.PURGE_REQUIRE_CHECKPOINT = "0";
		process.env.PURGE_DELAY_MS = "0";
		snapchainMock.castsByFid = [fixtureOld.snap];
		snapchainMock.castByIdResult = fixtureOld.snap;
		snapchainMock.submitHash = fixtureOld.hashHex;
		seedArchivedRow(fixtureOld);
		const result = await purgeRun({ live: true });
		expect(result.deleted).toBe(1);
		expect(snapchainMock.submitCalls.length).toBe(1);
		// the tombstone MUST already exist at the moment of submit
		expect(snapchainMock.submitCalls[0]?.tombstonePresentAtSubmit).toBe(true);
		// and the backup was written before any of this
		expect(readBackupFiles(fixtureOld.hashHex)).not.toBeNull();
		// confirmed tombstone remains
		const row = (db as unknown as SqliteDatabase)
			.query("SELECT reason FROM deleted_casts WHERE hash = ?")
			.get(fixtureOld.hashHex) as { reason: string } | undefined;
		expect(row?.reason).toBe("self-purge (not liked by owner)");
	});

	test("live: a like appearing after the snapshot aborts the delete", async () => {
		process.env.PURGE_MIN_AGE_DAYS = "7";
		process.env.PURGE_REQUIRE_CHECKPOINT = "0";
		process.env.PURGE_DELAY_MS = "0";
		snapchainMock.castsByFid = [fixtureOld.snap];
		snapchainMock.hasReaction = true;
		seedArchivedRow(fixtureOld);
		const result = await purgeRun({ live: true });
		expect(result.skipped).toBe(1);
		expect(result.deleted).toBe(0);
		expect(snapchainMock.submitCalls.length).toBe(0);
		const row = (db as unknown as SqliteDatabase)
			.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
			.get(fixtureOld.hashHex);
		expect(row).toBeFalsy();
	});
});

describe("self-heal", () => {
	test("purged casts missing from `casts` are re-inserted, tombstoned, and re-rendered from backups", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "farchiver-heal-out-"));
		backupMessage(fixtureOld.snap);
		// getCasts mock returns [] ⇒ the cast is treated as gone from the network
		const healed = await selfHealFromBackups(outDir);
		expect(healed).toBe(1);
		const row = (db as unknown as SqliteDatabase)
			.query("SELECT fid, data FROM casts WHERE hash = ?")
			.get(fixtureOld.hashHex) as { fid: number; data: string } | undefined;
		expect(row).toBeDefined();
		expect(row?.fid).toBe(3319217);
		const tombstone = (db as unknown as SqliteDatabase)
			.query("SELECT reason FROM deleted_casts WHERE hash = ?")
			.get(fixtureOld.hashHex) as { reason: string } | undefined;
		expect(tombstone?.reason).toBe("restored from backup");
	});
});
