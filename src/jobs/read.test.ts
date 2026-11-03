import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { getDb, initDb } from "../lib/db";
import { normalizeHash } from "../lib/helpers";
import {
	makeCast,
	makeHash,
	makeReply,
	withQuoteEmbed,
} from "../test/fixtures";
import {
	clearUserCache,
	countReplies,
	filterNonDeletedCastHashes,
	getCastFromHash,
	getMissingCastCount,
	getUserFromFid,
	hasCastInDb,
	isCastDeleted,
	markCastsDeleted,
	missingParentHashes,
	missingQuotedHashes,
	tagCast,
	tagCasts,
} from "./read";

const scalar = (sql: string, ...params: SQLQueryBindings[]): number => {
	const row = getDb()
		.query(sql)
		.get(...params) as { n: number } | undefined;
	return row?.n ?? 0;
};

beforeEach(() => {
	initDb(":memory:");
	clearUserCache();
});

describe("tagCast", () => {
	test("stores cast and user rows", async () => {
		await tagCast(makeCast());
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(1);
		expect(scalar("SELECT count(1) as n FROM users")).toBe(1);
	});

	test("is idempotent on repeated inserts", async () => {
		const cast = makeCast();
		await tagCast(cast);
		await tagCast(cast);
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(1);
	});

	test("normalizes parent_hash to 0x form", async () => {
		const parent = makeCast();
		const bareParentHash = parent.hash.replace(/^0x/, "");
		const reply = makeCast({
			parent_hash: bareParentHash,
			parent_author: { fid: 99 },
		});
		await tagCast(reply);
		const row = getDb()
			.query("SELECT parent_hash, parent_fid FROM casts WHERE hash = ?")
			.get(normalizeHash(reply.hash)) as {
			parent_hash: string;
			parent_fid: number;
		};
		expect(row.parent_hash).toBe(parent.hash);
		expect(row.parent_fid).toBe(99);
	});
});

describe("hasCastInDb", () => {
	test("accepts 0x and bare hash forms", async () => {
		const cast = makeCast();
		await tagCast(cast);
		expect(await hasCastInDb(cast.hash)).toBe(true);
		expect(await hasCastInDb(cast.hash.replace(/^0x/, ""))).toBe(true);
		expect(await hasCastInDb(makeHash())).toBe(false);
	});

	test("treats deleted casts as present", async () => {
		const hash = makeHash();
		await markCastsDeleted([hash], "test");
		expect(await hasCastInDb(hash)).toBe(true);
	});
});

describe("deleted casts", () => {
	test("markCastsDeleted filters hashes regardless of 0x prefix", async () => {
		const keep = makeHash();
		const drop = makeHash();
		await markCastsDeleted([drop], "test");
		expect(await isCastDeleted(drop)).toBe(true);
		expect(await isCastDeleted(drop.replace(/^0x/, ""))).toBe(true);
		expect(await isCastDeleted(keep)).toBe(false);
		expect(
			await filterNonDeletedCastHashes([keep, drop.replace(/^0x/, "")]),
		).toEqual([keep]);
	});

	test("filterNonDeletedCastHashes handles empty input", async () => {
		expect(await filterNonDeletedCastHashes([])).toEqual([]);
	});
});

describe("countReplies", () => {
	test("matches on parent_hash and parent_fid together", async () => {
		const parent = makeCast();
		await tagCast(parent);
		await tagCast(makeReply(parent));

		const other = makeCast({ author: { fid: 42 } });
		await tagCast(other);
		await tagCast(
			makeCast({
				parent_hash: parent.hash,
				parent_author: { fid: other.author.fid },
			}),
		);

		expect(await countReplies(parent.author.fid, parent.hash)).toBe(1);
		expect(await countReplies(other.author.fid, parent.hash)).toBe(1);
		expect(await countReplies(parent.author.fid, other.hash)).toBe(0);
	});
});

describe("getCastFromHash", () => {
	test("roundtrips stored cast data with bare hash lookup", async () => {
		const cast = makeCast();
		await tagCast(cast);
		const fetched = await getCastFromHash(
			cast.hash.replace(/^0x/, ""),
			cast.author.fid,
		);
		expect(fetched?.hash).toBe(cast.hash);
	});

	test("returns undefined for deleted casts", async () => {
		const cast = makeCast();
		await tagCast(cast);
		await markCastsDeleted([cast.hash], "test");
		expect(await getCastFromHash(cast.hash, cast.author.fid)).toBeUndefined();
	});

	test("tracks missing hashes and clears them on tagCast", async () => {
		const before = getMissingCastCount();
		const hash = makeHash();
		expect(await getCastFromHash(hash, undefined)).toBeUndefined();
		expect(getMissingCastCount()).toBe(before + 1);
		await tagCast(makeCast({ hash }));
		expect(getMissingCastCount()).toBe(before);
	});
});

describe("missingParentHashes", () => {
	test("finds absent parents, skips deleted, empties when satisfied", async () => {
		const parent = makeCast();
		const deletedParent = makeCast();
		await markCastsDeleted([deletedParent.hash], "test");

		await tagCast(makeReply(parent));
		await tagCast(makeReply(deletedParent));

		expect(await missingParentHashes()).toEqual([parent.hash]);

		await tagCast(parent);
		expect(await missingParentHashes()).toEqual([]);
	});
});

describe("tagCasts", () => {
	test("batches inserts transactionally and idempotently", async () => {
		const cast = makeCast();
		await tagCasts([cast, cast, makeCast()]);
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(2);
		expect(scalar("SELECT count(1) as n FROM users")).toBe(1);
	});

	test("handles empty input", async () => {
		await tagCasts([]);
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(0);
	});
});

describe("parent index", () => {
	test("countReplies query uses an index, not a table scan", () => {
		const plan = getDb()
			.query(
				"EXPLAIN QUERY PLAN SELECT count(1) as count FROM casts WHERE parent_hash = ? AND parent_fid = ?",
			)
			.all("0xabc", 1) as { detail: string }[];
		expect(
			plan.some((p) => /USING( COVERING)? INDEX/.test(p.detail)),
			plan.map((p) => p.detail).join("; "),
		).toBe(true);
	});
});

describe("cast_quotes", () => {
	test("tagCast records quote embeds with normalized hashes", async () => {
		const quoted = makeCast();
		await tagCast(quoted);
		await tagCast(withQuoteEmbed(quoted, true));
		expect(scalar("SELECT count(1) as n FROM cast_quotes")).toBe(1);
	});

	test("missingQuotedHashes matches legacy JSON scan exactly", async () => {
		const quotedPresent = makeCast();
		const quotedAbsent = makeCast();
		const quotedDeleted = makeCast();
		await markCastsDeleted([quotedDeleted.hash], "test");

		await tagCasts([
			withQuoteEmbed(quotedPresent),
			withQuoteEmbed(quotedAbsent),
			withQuoteEmbed(quotedDeleted),
		]);
		await tagCast(quotedPresent);

		const legacy = new Set<string>();
		for (const { data } of getDb().query("SELECT data FROM casts").all() as {
			data: string;
		}[]) {
			const cast = JSON.parse(data) as Cast;
			for (const embed of cast.embeds ?? []) {
				if (
					"cast_id" in embed &&
					embed.cast_id &&
					typeof embed.cast_id.hash === "string"
				) {
					const hash = normalizeHash(embed.cast_id.hash);
					if (!(await hasCastInDb(hash))) legacy.add(hash);
				}
			}
		}

		expect((await missingQuotedHashes()).sort()).toEqual([...legacy].sort());
		expect(await missingQuotedHashes()).toEqual([quotedAbsent.hash]);
	});
});

describe("getUserFromFid", () => {
	test("returns seeded user and memoizes the instance", async () => {
		await tagCast(makeCast());
		const first = await getUserFromFid(3319217);
		expect(first.username).toBe("artlu");
		const second = await getUserFromFid(3319217);
		expect(second).toBe(first);
	});
});

describe("file db", () => {
	const withTempDb = async (
		fn: (dbPath: string) => void | Promise<void>,
	): Promise<void> => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farchiver-"));
		try {
			await fn(path.join(dir, "queue.db3"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};

	test("runs in WAL mode and batched writes survive reopen", async () => {
		await withTempDb(async (dbPath) => {
			initDb(dbPath);
			await tagCasts([makeCast()]);
			const mode = getDb().query("PRAGMA journal_mode").get() as {
				journal_mode: string;
			};
			expect(mode.journal_mode).toBe("wal");
			initDb(dbPath);
			expect(scalar("SELECT count(1) as n FROM casts")).toBe(1);
		});
	});

	test("backfills cast_quotes from a legacy db without the table", async () => {
		await withTempDb(async (dbPath) => {
			const legacy = new Database(dbPath);
			legacy.run(
				"CREATE TABLE casts (hash TEXT PRIMARY KEY, fid INTEGER, data TEXT, parent_fid INTEGER, parent_hash TEXT)",
			);
			legacy.run(
				"CREATE TABLE deleted_casts (hash TEXT PRIMARY KEY, deleted_at INTEGER, reason TEXT)",
			);
			const quotedAbsent = makeCast();
			const quotedPresent = makeCast();
			for (const cast of [
				withQuoteEmbed(quotedAbsent),
				withQuoteEmbed(quotedPresent),
			]) {
				legacy
					.prepare("INSERT INTO casts (hash, fid, data) VALUES (?, ?, ?)")
					.run(cast.hash, cast.author.fid, JSON.stringify(cast));
			}
			legacy.close();

			initDb(dbPath);
			await tagCast(quotedPresent);
			expect(await missingQuotedHashes()).toEqual([quotedAbsent.hash]);
			const index = getDb()
				.query(
					"SELECT 1 as one FROM sqlite_master WHERE type = 'index' AND name = 'idx_casts_parent'",
				)
				.get();
			expect(index).toBeTruthy();

			initDb(dbPath);
			expect(await missingQuotedHashes()).toEqual([quotedAbsent.hash]);
		});
	});
});
