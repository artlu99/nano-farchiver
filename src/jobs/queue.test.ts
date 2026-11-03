import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Cast, Conversation } from "@neynar/nodejs-sdk/build/api";
import { initDb } from "../lib/db";
import { makeCast } from "../test/fixtures";

const convStats = {
	inFlight: 0,
	max: 0,
	calls: [] as string[],
};

const convFixture = (cast: Cast): Conversation =>
	({
		conversation: {
			cast: { ...cast, direct_replies: [] },
			chronological_parent_casts: [],
		},
	}) as unknown as Conversation;

const getConversationMock = async (hash: string): Promise<Conversation> => {
	convStats.calls.push(hash);
	convStats.inFlight += 1;
	convStats.max = Math.max(convStats.max, convStats.inFlight);
	await new Promise((r) => setTimeout(r, 20));
	convStats.inFlight -= 1;
	return convFixture(makeCast({ hash }));
};

mock.module("../lib/neynar", () => ({
	getConversation: getConversationMock,
	getCasts: async () => [],
}));

mock.module("../lib/snapchain", () => ({
	traverse: async () => [],
}));

const { hasCastInDb, queueLoop } = await import("./read");

beforeEach(() => {
	initDb(":memory:");
	convStats.calls = [];
	convStats.max = 0;
});

describe("queueLoop", () => {
	test("fetches thread and replies conversations concurrently", async () => {
		const cast = makeCast({
			thread_hash: makeCast().hash,
			parent_hash: makeCast().hash,
			parent_author: { fid: 9 },
		});
		await queueLoop([cast], true, 1);
		expect(convStats.max).toBeGreaterThanOrEqual(2);
	});

	test("tags thread root, parents, and replies into the archive", async () => {
		const threadRoot = makeCast();
		const cast = makeCast({
			thread_hash: threadRoot.hash,
			parent_hash: makeCast().hash,
			parent_author: { fid: 9 },
		});
		await queueLoop([cast], true, 1);
		expect(await hasCastInDb(threadRoot.hash)).toBe(true);
		expect(await hasCastInDb(cast.hash)).toBe(true);
		expect(convStats.calls).toEqual([threadRoot.hash, cast.hash]);
	});

	test("skips conversation fetches when fullConversationsMode is off", async () => {
		const cast = makeCast({ thread_hash: makeCast().hash });
		await queueLoop([cast], false, 1);
		expect(convStats.calls).toEqual([]);
	});
});
