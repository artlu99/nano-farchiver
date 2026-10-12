import { describe, expect, test } from "bun:test";
import { makeCast } from "../test/fixtures";
import { absentHashes, normalizeHash } from "./helpers";

describe("absentHashes", () => {
	test("returns requested hashes missing from returned casts, normalized", () => {
		const returned = [makeCast({ hash: "0xbbb2" }), makeCast({ hash: "ccc3" })];
		expect(
			absentHashes(["0xaaa1", "0xbbb2", "ccc3", "ddd4"], returned),
		).toEqual(["0xaaa1", "ddd4"]);
	});

	test("handles empty inputs", () => {
		expect(absentHashes([], [])).toEqual([]);
		expect(absentHashes(["0xaaa1"], [])).toEqual(["0xaaa1"]);
	});

	test("normalizeHash roundtrip stays stable", () => {
		expect(normalizeHash("abc")).toBe("0xabc");
		expect(normalizeHash("0xabc")).toBe("0xabc");
	});
});
