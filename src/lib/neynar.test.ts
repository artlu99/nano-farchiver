import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createStoreRunContext, type RunContext } from "../ctx";
import {
	hasCastInDb,
	hydrateReferencedParents,
	missingParentHashes,
	tagCasts,
} from "../jobs/read";
import { initDb } from "../lib/db";
import { MemoryStore } from "../store/memory";
import { makeCast, makeReply } from "../test/fixtures";
import { getCasts } from "./neynar";

// The store-vs-default backend trap: fetched casts must land in the run
// context's backend, not the implicit SQLite default. Before the ctx
// threading fix, getCasts tagged into defaultRunContext() — harmless when
// SQLite was the runtime, but under the bucket runtime it left meta/index.json
// permanently missing rows (timeline "[parent unavailable]").

const realFetch = globalThis.fetch;

const serveCasts = (casts: unknown[]): void => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (url.includes("/farcaster/casts/")) {
			return new Response(JSON.stringify({ casts }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`unexpected fetch in test: ${url}`);
	}) as typeof fetch;
};

const newRunContext = (): RunContext =>
	createStoreRunContext(new MemoryStore());

beforeEach(() => {
	initDb(":memory:");
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("getCasts ctx threading", () => {
	test("tags fetched casts into the given run context", async () => {
		const ctx = newRunContext();
		const cast = makeCast();
		serveCasts([cast]);

		await getCasts([cast.hash], ctx);

		expect(await hasCastInDb(cast.hash, ctx)).toBe(true);
		// ...and not into the implicit SQLite default context
		expect(await hasCastInDb(cast.hash)).toBe(false);
	});

	test("hydrateReferencedParents closes the missing-parent anti-join", async () => {
		const ctx = newRunContext();
		const parent = makeCast();
		const reply = makeReply(parent);
		await tagCasts([reply], ctx);
		expect(await missingParentHashes(ctx)).toEqual([parent.hash]);

		serveCasts([parent]);
		await hydrateReferencedParents(3, ctx);

		expect(await missingParentHashes(ctx)).toEqual([]);
		expect(await hasCastInDb(parent.hash, ctx)).toBe(true);
	});
});
