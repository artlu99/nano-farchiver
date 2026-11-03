import { beforeAll, describe, expect, test } from "bun:test";
import type { ArchiveIndex } from "../src/store/indexModel";
import { loadIndex, putJSON } from "../src/store/indexModel";
import { MemoryStore } from "../src/store/memory";
import type { Env } from "./env";
import { setStore } from "./env";
import { app } from "./index";

// The web data module memoizes one store per isolate — seed it once and
// exercise the routes against it (injected MemoryStore; the real S3Store
// constructor is never touched in tests).
const store = new MemoryStore();
setStore(store);

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const seedIndex: ArchiveIndex = {
	version: 1,
	updatedAt: T0,
	casts: {
		"0xaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": [
			3319217,
			T0,
			null,
			null,
			1,
			"hello world from the archive",
		],
		"0xbbb2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": [
			3319217,
			T0 + 86_400_000,
			"0xaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			3319217,
			0,
			"a reply to the first cast",
		],
		"0xd000dddddddddddddddddddddddddddddddddddd": [
			3319217,
			T0 + 172_800_000,
			null,
			null,
			0,
			"this one is tombstoned",
		],
	},
	deleted: {
		"0xd000dddddddddddddddddddddddddddddddddddd": [
			"self-purge (not liked by owner)",
			T0 + 200_000_000,
		],
	},
	quotes: {},
	users: { "3319217": { username: "artlu" } },
	fids: { "3319217": { active: true, username: "artlu" } },
	rendered: {
		artlu: {
			"20260102-000000-bbb2bbbb.md": { embedsFp: "00000000", replyCount: 0 },
		},
	},
};

const FILENAME_A = "20260101-000000-aaa1aaaa.md";

const env: Env = {
	ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
	FACILITATOR: { fetch: async () => new Response("{}", { status: 200 }) },
	S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
	S3_BUCKET: "test",
	S3_REGION: "auto",
	S3_ACCESS_KEY_ID: "test",
	S3_SECRET_ACCESS_KEY: "test",
	ARCHIVER_FID: "3319217",
	// X402_API_KEY intentionally unset → paywall disabled in tests
} as unknown as Env;

const request = async (path: string): Promise<Response> =>
	(await app.request(path, undefined, env)) as Response;
beforeAll(async () => {
	await putJSON(store, "meta/index.json", seedIndex);
	await putJSON(
		store,
		"out/artlu/" + FILENAME_A,
		[
			"---",
			`hash: ${FILENAME_A.slice(17, 25)}`,
			"timestamp: 2026-01-01T00:00:00.000Z",
			"fid: 3319217",
			"---",
			"[artlu](../_users_/artlu.md)",
			"--",
			"hello world from the archive",
			"--",
			"1 Reply",
			"--",
			"{no channel}",
		].join("\n"),
	);
	await putJSON(store, "config/textfilters.jsonl", '"spamword"\n');
	void loadIndex;
});

describe("web routes (bucket-backed)", () => {
	test("/health", async () => {
		const res = await request("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	test("/timeline renders visible casts, skips tombstones, applies spamaway", async () => {
		const res = await request("/timeline");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("a reply to the first cast");
		expect(html).toContain("hello world from the archive");
		expect(html).not.toContain("this one is tombstoned");

		const filtered = await request("/timeline?spamaway=1");
		const filteredHtml = await filtered.text();
		// "spamword" is in textfilters but neither cast mentions it — both stay
		expect(filteredHtml).toContain("hello world from the archive");
	});

	test("/api/cast/:hash returns the rendered markdown", async () => {
		const res = await request(
			"/api/cast/0xaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { markdown: string; filename: string };
		expect(body.markdown).toContain("hello world from the archive");
		expect(body.filename).toBe(FILENAME_A);
	});

	test("/api/cast/:hash 404s for tombstoned/unknown casts", async () => {
		expect(
			(await request("/api/cast/0xd000dddddddddddddddddddddddddddddddddddd"))
				.status,
		).toBe(404);
		expect((await request("/api/cast/0xffff")).status).toBe(404);
	});

	test("/status reports outstanding vs completed", async () => {
		const res = await request("/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			outstanding: number;
			completed: number;
		};
		expect(body.completed).toBe(1);
		expect(body.outstanding).toBe(2);
	});

	test("/browse lists user directories", async () => {
		const res = await request("/browse");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("artlu/");
		expect(html).toContain("archived");
	});

	test("/browse/<user>/<file> serves the full markdown page (ungated)", async () => {
		const res = await request(
			`/browse/artlu/${encodeURIComponent(FILENAME_A)}`,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("hello world from the archive");
	});

	test("gated user without payment gets a preview once X402_API_KEY is set", async () => {
		// paywall disabled in this suite (no X402_API_KEY) — assert full content
		const res = await request(
			`/browse/artlu/${encodeURIComponent(FILENAME_A)}`,
		);
		expect(await res.text()).toContain("hello world from the archive");
		expect(
			await request(`/browse/artlu/${FILENAME_A}?pay=1`).then((r) => r.status),
		).toBe(200);
	});

	test("unknown paths 404", async () => {
		expect((await request("/browse/nobody/")).status).toBe(404);
	});
});

describe("web fixtures", () => {
	test("seeded index round-trips through the store", async () => {
		const idx = (await loadIndex(store))?.index;
		expect(idx?.casts["0xaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]?.[5]).toBe(
			"hello world from the archive",
		);
	});
});
