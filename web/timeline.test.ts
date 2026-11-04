import { beforeEach, describe, expect, test } from "bun:test";
import type { ArchiveIndex } from "../src/store/indexModel";
import { resetSpamScoreCache, type ScoreFetcher } from "./spam-scores";
import { spamThresholdFromQuery } from "./spam-threshold";
import { timelineHtml } from "./timeline";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const H1 = "0xaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H2 = "0xbbb2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const H3 = "0xccc3cccccccccccccccccccccccccccccccccccc";

const fixtureIndex: ArchiveIndex = {
	version: 1,
	updatedAt: T0,
	casts: {
		[H1]: [3319217, T0, null, null, 0, "definitely spam cast words"],
		[H2]: [3319217, T0 + 1_000, null, null, 0, "a genuine conversation"],
		[H3]: [3319217, T0 + 2_000, null, null, 0, "unscored cast yet"],
	},
	deleted: {},
	quotes: {},
	users: { "3319217": { username: "artlu" } },
	fids: { "3319217": { active: true, username: "artlu" } },
	rendered: {},
};

describe("spamThresholdFromQuery", () => {
	test("parses 0-100, clamps and defaults", () => {
		expect(spamThresholdFromQuery(undefined)).toBe(0);
		expect(spamThresholdFromQuery("")).toBe(0);
		expect(spamThresholdFromQuery("70")).toBe(70);
		expect(spamThresholdFromQuery("85.9")).toBe(86);
		expect(spamThresholdFromQuery("-5")).toBe(0);
		expect(spamThresholdFromQuery("150")).toBe(100);
		expect(spamThresholdFromQuery("abc")).toBe(0);
	});
});

describe("timeline spam-score slider", () => {
	test("hides casts scoring at/above the threshold, keeps unscored", async () => {
		resetSpamScoreCache();
		// H1 = 0.95 spam, H2 = 0.10, H3 = unscored (null)
		const fetcher: ScoreFetcher = async () =>
			Response.json({
				[H1.toLowerCase()]: 0.95,
				[H2.toLowerCase()]: 0.1,
				[H3.toLowerCase()]: null,
			});

		const res = await timelineHtml(fixtureIndex, {
			limit: 20,
			previewLength: 80,
			spamaway: true,
			textfilters: [],
			spamThreshold: 70,
			scoreFetcher: fetcher,
		});
		const html = await res.text();
		expect(html).toContain("a genuine conversation");
		expect(html).toContain("unscored cast yet");
		expect(html).not.toContain("definitely spam cast words");
		expect(html).toContain('id="spam-threshold"');
		expect(html).toContain('value="70"');
	});

	test("threshold 0 = filter off, no score fetch", async () => {
		resetSpamScoreCache();
		let calls = 0;
		const fetcher: ScoreFetcher = async () => {
			calls += 1;
			return Response.json({});
		};
		const res = await timelineHtml(fixtureIndex, {
			limit: 20,
			previewLength: 80,
			spamaway: true,
			textfilters: [],
			spamThreshold: 0,
			scoreFetcher: fetcher,
		});
		expect(res.status).toBe(200);
		expect(calls).toBe(0);
	});

	test("null scores keep casts visible (fail-open)", async () => {
		resetSpamScoreCache();
		const fetcher: ScoreFetcher = async () => Response.json({});
		const res = await timelineHtml(fixtureIndex, {
			limit: 20,
			previewLength: 80,
			spamaway: true,
			textfilters: [],
			spamThreshold: 70,
			scoreFetcher: fetcher,
		});
		const html = await res.text();
		expect(html).toContain("definitely spam cast words");
	});
});
