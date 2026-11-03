import { beforeEach, describe, expect, test } from "bun:test";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { createStoreRunContext, type RunContext } from "../ctx";
import {
	countReplies,
	filterNonDeletedCastHashes,
	getCastFromHash,
	getMissingCastCount,
	hasCastInDb,
	isCastDeleted,
	markCastsDeleted,
	missingParentHashes,
	missingQuotedHashes,
	tagCast,
	tagCasts,
} from "../jobs/read";
import { castsLoop } from "../jobs/write";
import { hash2filename, normalizeHash } from "../lib/helpers";
import {
	castKey,
	deletedKey,
	emptyIndex,
	getJSON,
	listAllKeys,
	loadIndex,
	saveIndex,
	userKey,
} from "../store/indexModel";
import { MemoryStore } from "../store/memory";
import {
	makeCast,
	makeHash,
	makeReply,
	withQuoteEmbed,
} from "../test/fixtures";

let store: MemoryStore;
let ctx: RunContext;

beforeEach(() => {
	store = new MemoryStore();
	ctx = createStoreRunContext(store);
});

const index = async () => (await loadIndex(store))?.index;

describe("tagCast (store-backed)", () => {
	test("writes cast + user objects and index entries", async () => {
		const cast = makeCast();
		await tagCast(cast, ctx);
		expect(await getJSON<Cast>(store, castKey(cast.hash))).toEqual(cast);
		expect(await getJSON(store, userKey(cast.author.fid))).toMatchObject({
			fid: cast.author.fid,
			username: "artlu",
		});
		const idx = await index();
		expect(idx?.casts[normalizeHash(cast.hash)]).toBeDefined();
		expect(idx?.users[String(cast.author.fid)]).toEqual({
			username: "artlu",
		});
	});

	test("is idempotent: re-tag does not duplicate", async () => {
		const cast = makeCast();
		await tagCast(cast, ctx);
		await tagCast(cast, ctx);
		const idx = await index();
		expect(Object.keys(idx?.casts ?? {})).toHaveLength(1);
		expect(Object.keys(idx?.users ?? {})).toHaveLength(1);
	});

	test("normalizes parent_hash/parent_fid into the index entry", async () => {
		const parent = makeCast();
		const reply = makeCast({
			parent_hash: parent.hash.replace(/^0x/, ""),
			parent_author: { fid: 99 },
		});
		await tagCast(reply, ctx);
		const idx = await index();
		expect(idx?.casts[normalizeHash(reply.hash)]?.[2]).toBe(parent.hash);
		expect(idx?.casts[normalizeHash(reply.hash)]?.[3]).toBe(99);
		expect(idx?.casts[normalizeHash(reply.hash)]?.[0]).toBe(3319217);
	});

	test("never resurrects tombstoned casts", async () => {
		const cast = makeCast();
		await markCastsDeleted([cast.hash], "test", Date.now(), ctx);
		await tagCast(cast, ctx);
		const idx = await index();
		expect(idx?.casts[normalizeHash(cast.hash)]).toBeUndefined();
		expect(await hasCastInDb(cast.hash, ctx)).toBe(true);
	});

	test("bumps parent replyCount as replies are tagged", async () => {
		const parent = makeCast();
		await tagCast(parent, ctx);
		await tagCast(makeReply(parent), ctx);
		await tagCast(makeReply(parent), ctx);
		const idx = await index();
		expect(idx?.casts[normalizeHash(parent.hash)]?.[4]).toBe(2);
	});
});

describe("hasCastInDb / tombstones (store-backed)", () => {
	test("accepts 0x and bare hash forms", async () => {
		const cast = makeCast();
		await tagCast(cast, ctx);
		expect(await hasCastInDb(cast.hash, ctx)).toBe(true);
		expect(await hasCastInDb(cast.hash.replace(/^0x/, ""), ctx)).toBe(true);
		expect(await hasCastInDb(makeHash(), ctx)).toBe(false);
	});

	test("tombstone objects + index entry, filters by either form", async () => {
		const keep = makeHash();
		const drop = makeHash();
		await markCastsDeleted([drop], "test", Date.now(), ctx);
		expect(await getJSON(store, deletedKey(drop))).toMatchObject({
			reason: "test",
		});
		expect(await isCastDeleted(drop, ctx)).toBe(true);
		expect(await isCastDeleted(drop.replace(/^0x/, ""), ctx)).toBe(true);
		expect(
			await filterNonDeletedCastHashes([keep, drop.replace(/^0x/, "")], ctx),
		).toEqual([keep]);
	});
});

describe("countReplies (store-backed)", () => {
	test("matches on parent_hash and parent_fid together", async () => {
		const parent = makeCast();
		await tagCast(parent, ctx);
		await tagCast(makeReply(parent), ctx);

		const other = makeCast({ author: { fid: 42 } });
		await tagCast(other, ctx);
		await tagCast(
			makeCast({
				parent_hash: parent.hash,
				parent_author: { fid: other.author.fid },
			}),
			ctx,
		);

		expect(await countReplies(parent.author.fid, parent.hash, ctx)).toBe(1);
		expect(await countReplies(other.author.fid, parent.hash, ctx)).toBe(1);
		expect(await countReplies(parent.author.fid, other.hash, ctx)).toBe(0);
	});
});

describe("getCastFromHash (store-backed)", () => {
	test("roundtrips stored cast data with bare hash lookup", async () => {
		const cast = makeCast();
		await tagCast(cast, ctx);
		const fetched = await getCastFromHash(
			cast.hash.replace(/^0x/, ""),
			cast.author.fid,
			ctx,
		);
		expect(fetched?.hash).toBe(cast.hash);
	});

	test("returns undefined for deleted casts without tracking them as missing", async () => {
		const cast = makeCast();
		await tagCast(cast, ctx);
		await markCastsDeleted([cast.hash], "test", Date.now(), ctx);
		expect(
			await getCastFromHash(cast.hash, cast.author.fid, ctx),
		).toBeUndefined();
	});

	test("tracks missing hashes and clears them on tagCast", async () => {
		const before = getMissingCastCount(ctx);
		const hash = makeHash();
		expect(await getCastFromHash(hash, undefined, ctx)).toBeUndefined();
		expect(getMissingCastCount(ctx)).toBe(before + 1);
		await tagCast(makeCast({ hash }), ctx);
		expect(getMissingCastCount(ctx)).toBe(before);
	});

	test("fid mismatch returns undefined", async () => {
		const cast = makeCast();
		await tagCast(cast, ctx);
		expect(
			await getCastFromHash(cast.hash, cast.author.fid + 1, ctx),
		).toBeUndefined();
	});
});

describe("hydration anti-joins (store-backed)", () => {
	test("missingParentHashes finds absent parents, skips deleted", async () => {
		const parent = makeCast();
		const deletedParent = makeCast();
		await markCastsDeleted([deletedParent.hash], "test", Date.now(), ctx);

		await tagCast(makeReply(parent), ctx);
		await tagCast(makeReply(deletedParent), ctx);

		expect(await missingParentHashes(ctx)).toEqual([parent.hash]);

		await tagCast(parent, ctx);
		expect(await missingParentHashes(ctx)).toEqual([]);
	});

	test("missingQuotedHashes matches quote embeds", async () => {
		const quotedPresent = makeCast();
		const quotedAbsent = makeCast();
		const quotedDeleted = makeCast();
		const embedPresent = withQuoteEmbed(quotedPresent);
		const embedAbsent = withQuoteEmbed(quotedAbsent);
		const embedDeleted = withQuoteEmbed(quotedDeleted);
		await markCastsDeleted([quotedDeleted.hash], "test", Date.now(), ctx);

		await tagCasts([embedPresent, embedAbsent, embedDeleted], ctx);
		await tagCast(quotedPresent, ctx);

		expect(await missingQuotedHashes(ctx)).toEqual([quotedAbsent.hash]);
		const idx = await index();
		expect(idx?.quotes[normalizeHash(embedPresent.hash)]).toEqual([
			quotedPresent.hash,
		]);
	});
});

describe("listings (store-backed)", () => {
	test("listCasts is hash-ordered; per-fid hash list matches", async () => {
		const a = makeCast();
		const b = makeCast();
		await tagCasts([b, a], ctx);
		const refs = await ctx.data.listCasts();
		expect(refs.map((r) => r.hash)).toEqual(
			[a.hash, b.hash].sort((x, y) => x.localeCompare(y)),
		);
		for (const ref of refs) {
			expect(await ctx.data.listCastHashesByFid(ref.fid)).toContain(ref.hash);
		}
		expect(await ctx.data.listUserFids()).toEqual([3319217]);
	});
});

describe("tombstone ledger + heal (store-backed)", () => {
	test("listDeleted is newest-first; unmarkDeleted releases", async () => {
		const first = makeHash();
		const second = makeHash();
		await markCastsDeleted([first], "test", 1000, ctx);
		await markCastsDeleted(
			[second],
			"self-purge (not liked by owner)",
			2000,
			ctx,
		);
		const ledger = await ctx.data.listDeleted();
		expect(ledger.map((entry) => entry.hash)).toEqual([second, first]);
		expect(ledger[0]?.reason).toBe("self-purge (not liked by owner)");

		await ctx.data.unmarkDeleted(second);
		expect(await ctx.data.listDeleted()).toHaveLength(1);
		expect(await store.get(deletedKey(second))).toBeNull();
	});

	test("restoreTombstonedCast stores cast + tombstone, idempotently", async () => {
		const cast = makeCast();
		await ctx.data.restoreTombstonedCast(cast, "restored from backup", 5000);
		expect(await getJSON<Cast>(store, castKey(cast.hash))).toEqual(cast);
		expect(await getJSON(store, deletedKey(cast.hash))).toMatchObject({
			reason: "restored from backup",
		});
		const idx = await index();
		expect(idx?.casts[normalizeHash(cast.hash)]).toBeDefined();
		expect(idx?.deleted[normalizeHash(cast.hash)]).toBeDefined();

		// re-heal does not duplicate or resurrect differently
		await ctx.data.restoreTombstonedCast(cast, "restored from backup", 6000);
		expect(await ctx.data.listDeleted()).toHaveLength(1);
	});

	test("castsLoop renders through the store sink", async () => {
		const parent = makeCast();
		await tagCasts([parent], ctx);
		await castsLoop("ignored-by-store-sink", ctx);
		const rel = `artlu/${hash2filename(parent.hash, parent.timestamp)}`;
		const obj = await store.get(`out/${rel}`);
		expect(obj).not.toBeNull();
		expect(obj && new TextDecoder().decode(obj.body)).toContain("hello");
		// second run: no rewrite (skip-if-rendered read path)
		const before = obj?.etag;
		await castsLoop("ignored-by-store-sink", ctx);
		expect((await store.get(`out/${rel}`))?.etag).toBe(before);
	});
});

describe("deferred commits (store backend)", () => {
	test("mutations stay in memory until flush, then land as one write", async () => {
		const cast = makeCast();
		await ctx.data.deferCommits();
		await tagCast(cast, ctx);
		await markCastsDeleted(["0xdead0"], "test", 1000, ctx);

		// visible to in-run reads immediately (single-writer authority)
		expect(await hasCastInDb("0xdead0", ctx)).toBe(true);
		// but not yet committed to the store
		expect(await loadIndex(store)).toBeNull();
		expect(await store.get(castKey(cast.hash))).not.toBeNull(); // objects land eagerly

		await ctx.data.flushCommits();
		const idx = (await loadIndex(store))?.index;
		expect(idx?.casts[normalizeHash(cast.hash)]).toBeDefined();
		expect(idx?.deleted["0xdead0"]).toBeDefined();
		expect(await hasCastInDb("0xdead0", ctx)).toBe(true);
	});

	test("flush wins over a racing writer (single-writer last word)", async () => {
		await ctx.data.deferCommits();
		await tagCast(makeCast({ hash: "0xabc0" }), ctx);
		// a concurrent writer lands a different index first (etag moves)
		await saveIndex(store, emptyIndex(), undefined);
		await ctx.data.flushCommits();

		const idx = (await loadIndex(store))?.index;
		expect(idx?.casts["0xabc0"]).toBeDefined();
	});

	test("renders marked during defer are flushed too", async () => {
		const parent = makeCast();
		await ctx.data.deferCommits();
		await tagCasts([parent], ctx);
		await castsLoop("ignored", ctx);
		await ctx.data.flushCommits();

		const idx = (await loadIndex(store))?.index;
		const filename = hash2filename(parent.hash, parent.timestamp);
		expect(idx?.rendered.artlu?.[filename]).toBeDefined();
	});
});

describe("reactions + settings (store-backed)", () => {
	test("upsert + full-refresh delete of stale keys, fid-scoped", async () => {
		await ctx.data.upsertReactions(3319217, [
			{ hash: "0xaaa1", type: "like", updatedAt: 1 },
			{ hash: "0xbbb2", type: "like", updatedAt: 2 },
		]);
		await ctx.data.upsertReactions(42, [
			{ hash: "0xaaa1", type: "like", updatedAt: 3 },
		]);
		// new run touches only 0xaaa1 → 0xbbb2 goes stale for this fid,
		// fid 42's like is untouched (fid-scoped keys)
		await ctx.data.deleteReactionsNotIn(3319217, [
			{ hash: "0xaaa1", type: "like" },
		]);
		const keys = await listAllKeys(store, "reactions/");
		expect(keys).toContain("reactions/3319217/aaa1#like.json");
		expect(keys).toContain("reactions/42/aaa1#like.json");
		expect(keys).not.toContain("reactions/3319217/bbb2#like.json");
	});

	test("getSetting/setSetting roundtrip", async () => {
		await ctx.data.setSetting("purge_min_age_days", "30");
		expect(await ctx.data.getSetting("purge_min_age_days")).toBe("30");
		await ctx.data.setSetting("purge_min_age_days:42", "3");
		expect(await ctx.data.getSetting("purge_min_age_days:42")).toBe("3");
	});
});
