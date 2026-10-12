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
	test("stores cast and user rows", () => {
		tagCast(makeCast());
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(1);
		expect(scalar("SELECT count(1) as n FROM users")).toBe(1);
	});

	test("is idempotent on repeated inserts", () => {
		const cast = makeCast();
		tagCast(cast);
		tagCast(cast);
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(1);
	});

	test("normalizes parent_hash to 0x form", () => {
		const parent = makeCast();
		const bareParentHash = parent.hash.replace(/^0x/, "");
		const reply = makeCast({
			parent_hash: bareParentHash,
			parent_author: { fid: 99 },
		});
		tagCast(reply);
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
	test("accepts 0x and bare hash forms", () => {
		const cast = makeCast();
		tagCast(cast);
		expect(hasCastInDb(cast.hash)).toBe(true);
		expect(hasCastInDb(cast.hash.replace(/^0x/, ""))).toBe(true);
		expect(hasCastInDb(makeHash())).toBe(false);
	});

	test("treats deleted casts as present", () => {
		const hash = makeHash();
		markCastsDeleted([hash], "test");
		expect(hasCastInDb(hash)).toBe(true);
	});
});

describe("deleted casts", () => {
	test("markCastsDeleted filters hashes regardless of 0x prefix", () => {
		const keep = makeHash();
		const drop = makeHash();
		markCastsDeleted([drop], "test");
		expect(isCastDeleted(drop)).toBe(true);
		expect(isCastDeleted(drop.replace(/^0x/, ""))).toBe(true);
		expect(isCastDeleted(keep)).toBe(false);
		expect(filterNonDeletedCastHashes([keep, drop.replace(/^0x/, "")])).toEqual(
			[keep],
		);
	});

	test("filterNonDeletedCastHashes handles empty input", () => {
		expect(filterNonDeletedCastHashes([])).toEqual([]);
	});
});

describe("countReplies", () => {
	test("matches on parent_hash and parent_fid together", () => {
		const parent = makeCast();
		tagCast(parent);
		tagCast(makeReply(parent));

		const other = makeCast({ author: { fid: 42 } });
		tagCast(other);
		tagCast(
			makeCast({
				parent_hash: parent.hash,
				parent_author: { fid: other.author.fid },
			}),
		);

		expect(countReplies(parent.author.fid, parent.hash)).toBe(1);
		expect(countReplies(other.author.fid, parent.hash)).toBe(1);
		expect(countReplies(parent.author.fid, other.hash)).toBe(0);
	});
});

describe("getCastFromHash", () => {
	test("roundtrips stored cast data with bare hash lookup", () => {
		const cast = makeCast();
		tagCast(cast);
		const fetched = getCastFromHash(
			cast.hash.replace(/^0x/, ""),
			cast.author.fid,
		);
		expect(fetched?.hash).toBe(cast.hash);
	});

	test("returns undefined for deleted casts", () => {
		const cast = makeCast();
		tagCast(cast);
		markCastsDeleted([cast.hash], "test");
		expect(getCastFromHash(cast.hash, cast.author.fid)).toBeUndefined();
	});

	test("tracks missing hashes and clears them on tagCast", () => {
		const before = getMissingCastCount();
		const hash = makeHash();
		expect(getCastFromHash(hash, undefined)).toBeUndefined();
		expect(getMissingCastCount()).toBe(before + 1);
		tagCast(makeCast({ hash }));
		expect(getMissingCastCount()).toBe(before);
	});
});

describe("missingParentHashes", () => {
	test("finds absent parents, skips deleted, empties when satisfied", () => {
		const parent = makeCast();
		const deletedParent = makeCast();
		markCastsDeleted([deletedParent.hash], "test");

		tagCast(makeReply(parent));
		tagCast(makeReply(deletedParent));

		expect(missingParentHashes()).toEqual([parent.hash]);

		tagCast(parent);
		expect(missingParentHashes()).toEqual([]);
	});
});

describe("tagCasts", () => {
	test("batches inserts transactionally and idempotently", () => {
		const cast = makeCast();
		tagCasts([cast, cast, makeCast()]);
		expect(scalar("SELECT count(1) as n FROM casts")).toBe(2);
		expect(scalar("SELECT count(1) as n FROM users")).toBe(1);
	});

	test("handles empty input", () => {
		tagCasts([]);
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
	test("tagCast records quote embeds with normalized hashes", () => {
		const quoted = makeCast();
		tagCast(quoted);
		tagCast(withQuoteEmbed(quoted, true));
		expect(scalar("SELECT count(1) as n FROM cast_quotes")).toBe(1);
	});

	test("missingQuotedHashes matches legacy JSON scan exactly", () => {
		const quotedPresent = makeCast();
		const quotedAbsent = makeCast();
		const quotedDeleted = makeCast();
		markCastsDeleted([quotedDeleted.hash], "test");

		tagCasts([
			withQuoteEmbed(quotedPresent),
			withQuoteEmbed(quotedAbsent),
			withQuoteEmbed(quotedDeleted),
		]);
		tagCast(quotedPresent);

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
					if (!hasCastInDb(hash)) legacy.add(hash);
				}
			}
		}

		expect(missingQuotedHashes().sort()).toEqual([...legacy].sort());
		expect(missingQuotedHashes()).toEqual([quotedAbsent.hash]);
	});
});

describe("getUserFromFid", () => {
	test("returns seeded user and memoizes the instance", async () => {
		tagCast(makeCast());
		const first = await getUserFromFid(3319217);
		expect(first.username).toBe("artlu");
		const second = await getUserFromFid(3319217);
		expect(second).toBe(first);
	});
});

describe("file db", () => {
	const withTempDb = (fn: (dbPath: string) => void) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farchiver-"));
		try {
			fn(path.join(dir, "queue.db3"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};

	test("runs in WAL mode and batched writes survive reopen", () => {
		withTempDb((dbPath) => {
			initDb(dbPath);
			tagCasts([makeCast()]);
			const mode = getDb().query("PRAGMA journal_mode").get() as {
				journal_mode: string;
			};
			expect(mode.journal_mode).toBe("wal");
			initDb(dbPath);
			expect(scalar("SELECT count(1) as n FROM casts")).toBe(1);
		});
	});

	test("backfills cast_quotes from a legacy db without the table", () => {
		withTempDb((dbPath) => {
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
			tagCast(quotedPresent);
			expect(missingQuotedHashes()).toEqual([quotedAbsent.hash]);
			const index = getDb()
				.query(
					"SELECT 1 as one FROM sqlite_master WHERE type = 'index' AND name = 'idx_casts_parent'",
				)
				.get();
			expect(index).toBeTruthy();

			initDb(dbPath);
			expect(missingQuotedHashes()).toEqual([quotedAbsent.hash]);
		});
	});
});
