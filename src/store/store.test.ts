import { describe, expect, test } from "bun:test";
import {
	castKey,
	commitIndex,
	embedsFingerprint,
	listAllKeys,
	loadIndex,
	previewOf,
	reactionKey,
	userKey,
} from "./indexModel";
import { MemoryStore } from "./memory";
import { PreconditionFailedError, textToBytes } from "./types";

describe("MemoryStore", () => {
	test("put/get roundtrip with fresh etag per write", async () => {
		const store = new MemoryStore();
		const first = await store.put("a/b.json", '{"x":1}');
		const obj = await store.get("a/b.json");
		expect(obj?.etag).toBe(first.etag);
		expect(obj && new TextDecoder().decode(obj.body)).toBe('{"x":1}');
		const second = await store.put("a/b.json", '{"x":2}');
		expect(second.etag).not.toBe(first.etag);
		expect(await store.get("missing")).toBeNull();
	});

	test("ifMatch guards against stale overwrite", async () => {
		const store = new MemoryStore();
		const { etag } = await store.put("k", "v1");
		await store.put("k", "v2", { ifMatch: etag });
		expect(store.put("k", "v3", { ifMatch: etag })).rejects.toThrow(
			PreconditionFailedError,
		);
	});

	test("ifNoneMatch * is create-only", async () => {
		const store = new MemoryStore();
		await store.put("k", "v1", { ifNoneMatch: "*" });
		expect(store.put("k", "v2", { ifNoneMatch: "*" })).rejects.toThrow(
			PreconditionFailedError,
		);
	});

	test("deleteKey is idempotent", async () => {
		const store = new MemoryStore();
		await store.put("k", textToBytes("v"));
		await store.deleteKey("k");
		await store.deleteKey("k");
		expect(await store.get("k")).toBeNull();
	});

	test("list groups by delimiter like S3 ListObjectsV2", async () => {
		const store = new MemoryStore();
		for (const key of [
			"out/a.md",
			"out/u1/x.md",
			"out/u1/y.md",
			"backups/m.jsonl",
		]) {
			await store.put(key, "x");
		}
		const page = await store.list("out/", { delimiter: "/" });
		expect(page.keys).toEqual(["out/a.md"]);
		expect(page.prefixes).toEqual(["out/u1/"]);
		expect(page.truncated).toBe(false);
		expect(await listAllKeys(store, "out/")).toHaveLength(3);
	});
});

describe("commitIndex", () => {
	test("creates the index when missing, then mutates atomically", async () => {
		const store = new MemoryStore();
		const created = await commitIndex(store, (draft) => {
			draft.casts["0xabc"] = [1, 0, null, null, 0, "hello"];
		});
		expect(created.index.casts["0xabc"]?.[5]).toBe("hello");
		expect(created.index.updatedAt).toBeGreaterThan(0);
		expect(created.etag).toBeDefined();
		expect(await loadIndex(store)).not.toBeNull();

		const updated = await commitIndex(store, (draft) => {
			draft.users[1] = { username: "alice" };
		});
		expect(updated.index.casts["0xabc"]).toBeDefined();
		expect(updated.index.users[1]?.username).toBe("alice");
	});
});

describe("key builders", () => {
	test("normalize hashes and scope by fid", () => {
		expect(castKey("abc")).toBe("casts/abc.json");
		expect(castKey("0xabc")).toBe("casts/abc.json");
		expect(reactionKey(42, "0xab", "like")).toBe("reactions/42/ab#like.json");
		expect(userKey(42)).toBe("users/42.json");
	});
});

describe("index entry helpers", () => {
	test("previewOf caps length", () => {
		expect(previewOf("x".repeat(500))).toHaveLength(200);
		expect(previewOf("short")).toBe("short");
	});

	test("embedsFingerprint is stable and input-sensitive", () => {
		const a = embedsFingerprint([{ url: "https://x/y.png" }]);
		expect(embedsFingerprint([{ url: "https://x/y.png" }])).toBe(a);
		expect(embedsFingerprint([{ url: "https://x/z.png" }])).not.toBe(a);
		expect(embedsFingerprint(undefined)).toBe(embedsFingerprint([]));
	});
});
