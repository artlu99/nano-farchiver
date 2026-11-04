import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cast, Conversation } from "@neynar/nodejs-sdk/build/api";
import { createStoreRunContext, type RunContext } from "../ctx";
import { initDb } from "../lib/db";
import { hash2filename, normalizeHash } from "../lib/helpers";
import { loadIndex } from "../store/indexModel";
import { MemoryStore } from "../store/memory";
import { makeCast } from "../test/fixtures";
import type { TickProgress } from "./tick";

// self-heal must no-op in tests: point BACKUPS_DIR at an empty temp dir
process.env.BACKUPS_DIR = mkdtempSync(
	join(tmpdir(), "farchiver-tick-backups-"),
);

const stats = { conversations: [] as string[] };
let feedCasts: Cast[] = [];

const convFixture = (cast: Cast): Conversation =>
	({
		conversation: {
			cast: { ...cast, direct_replies: [] },
			chronological_parent_casts: [],
		},
	}) as unknown as Conversation;

mock.module("../lib/neynar", () => ({
	getConversation: async (hash: string): Promise<Conversation> => {
		stats.conversations.push(hash);
		return convFixture(makeCast({ hash }));
	},
	getCasts: async () => [],
	getCronFeed: async (): Promise<{ casts: Cast[]; next: null }> => ({
		casts: feedCasts,
		next: null,
	}),
	getReplies: async (): Promise<{ casts: Cast[]; next: null }> => ({
		casts: [],
		next: null,
	}),
}));

mock.module("../lib/snapchain", () => ({
	traverse: async () => [],
}));

const { runTick } = await import("./tick");

let store: MemoryStore;
let ctx: RunContext;

const hashAt = (n: number): string =>
	`0x${n.toString(16).padStart(4, "0")}${"a".repeat(36)}`;

beforeEach(() => {
	store = new MemoryStore();
	ctx = createStoreRunContext(store);
	initDb(":memory:");
	stats.conversations = [];
	feedCasts = [];
});

describe("runTick (budgeted pipeline)", () => {
	test("unknown casts consume the budget; cursor waits for the sweep", async () => {
		feedCasts = [0, 1, 2, 3, 4].map((i) => makeCast({ hash: hashAt(i) }));

		const first = await runTick(3319217, ctx, {
			hydrateBudget: 2,
			tickMs: 60_000,
		});
		expect(first.unknown).toBe(5);
		expect(first.hydrated).toBe(2);
		// rotation never ran (budget spent on unknowns) — cursor untouched
		expect(first.offset).toBe(0);
		expect(stats.conversations.length).toBe(2);

		// next tick: all casts are known now → pure rotation sweep
		const second = await runTick(3319217, ctx, {
			hydrateBudget: 2,
			tickMs: 60_000,
		});
		expect(second.unknown).toBe(0);
		expect(second.hydrated).toBe(2);
		expect(second.offset).toBe(2);
		// 4 casts hydrated total; the sweep restarted at offset 0, so the two
		// previously-hydrated casts are re-read (idempotent re-hydration)
		expect(stats.conversations.length).toBe(4);
		expect(stats.conversations).toEqual([
			hashAt(0),
			hashAt(1),
			hashAt(0),
			hashAt(1),
		]);
	});

	test("rotation wraps around the feed list", async () => {
		feedCasts = [10, 11, 12, 13].map((i) => makeCast({ hash: hashAt(i) }));
		// first pass: everything known → the sweep is what runs
		await runTick(3319217, ctx, { hydrateBudget: 10, tickMs: 60_000 });
		await ctx.data.setSetting("tick_cursor:3319217", "3");
		stats.conversations = [];

		const second = await runTick(3319217, ctx, {
			hydrateBudget: 2,
			tickMs: 60_000,
		});
		// offset 3 wraps: positions 3 then 0
		expect(second.hydrated).toBe(2);
		expect(second.offset).toBe(1);
	});

	test("renders land in the bucket and the rendered map after flush", async () => {
		const cast = makeCast({ hash: hashAt(20) });
		feedCasts = [cast];
		await runTick(3319217, ctx, { hydrateBudget: 5, tickMs: 60_000 });

		const idx = (await loadIndex(store))?.index;
		const entry = idx?.casts[normalizeHash(cast.hash)];
		if (!entry) throw new Error("expected index entry for cast");
		const filename = hash2filename(cast.hash, new Date(entry[1]));
		const obj = await store.get(`out/artlu/${filename}`);
		expect(obj).not.toBeNull();
		expect(idx?.rendered.artlu?.[filename]).toBeDefined();
	});

	test("onProgress ends with a terminal running:false event", async () => {
		feedCasts = [40, 41].map((i) => makeCast({ hash: hashAt(i) }));
		const events: TickProgress[] = [];
		await runTick(3319217, ctx, {
			hydrateBudget: 5,
			tickMs: 60_000,
			onProgress: (p) => events.push(p),
		});

		const last = events[events.length - 1];
		if (!last) throw new Error("expected at least one progress event");
		expect(last.running).toBe(false);
		expect(last.phase).toBe("idle");
		expect(last.completedAt).toBeNumber();
		expect(last.lastLine).toBe("done");
		// final counters land in the terminal event (renders happened);
		// hydrated = 2 unknown-first + 2 sweep re-reads (budget 5 not spent)
		expect(last.hydrated).toBe(4);
		expect(last.renders).toBe(2);
		expect(last.scanned).toBe(2);
		// every mid-run event reports running:true
		for (const e of events.slice(0, -1)) expect(e.running).toBe(true);
	});
});
