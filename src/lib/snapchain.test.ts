import { describe, expect, test } from "bun:test";
import { traverse } from "./snapchain";

type Node = { fid: number | undefined; hash: string };

const treeChildren = (hash: string): Node[] => {
	switch (hash) {
		case "0xaaa1":
			return [
				{ fid: 1, hash: "0xbbb1" },
				{ fid: 2, hash: "0xccc1" },
			];
		case "0xbbb1":
			return [{ fid: 3, hash: "0xddd1" }];
		case "0xccc1":
			return [];
		case "0xddd1":
			return [{ fid: 100, hash: "0xaaa1" }];
		default:
			return [];
	}
};

describe("traverse", () => {
	test("visits every reachable node and records first-seen fids", async () => {
		const seen = await traverse(100, "0xaaa1", async (fid, hash) => {
			await new Promise((r) => setTimeout(r, 1));
			return treeChildren(hash).map((n) => ({ ...n, fid: n.fid ?? fid }));
		});
		const byHash = new Map(seen.map((n) => [n.hash, n.fid]));
		expect(byHash.get("0xaaa1")).toBe(100);
		expect(byHash.get("0xbbb1")).toBe(1);
		expect(byHash.get("0xccc1")).toBe(2);
		expect(byHash.get("0xddd1")).toBe(3);
	});

	test("terminates on cycles", async () => {
		const seen = await traverse(100, "0xaaa1", async (_fid, hash) =>
			treeChildren(hash),
		);
		expect(seen).toHaveLength(4);
	});

	test("fetches frontier levels concurrently", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		await traverse(100, "0xaaa1", async (_fid, hash) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			return treeChildren(hash);
		});
		expect(maxInFlight).toBeGreaterThanOrEqual(2);
	});

	test("maps undefined fid to 0 for child queries", async () => {
		const queried: number[] = [];
		await traverse(undefined, "0xaaa1", async (fid) => {
			queried.push(fid);
			return [];
		});
		expect(queried).toEqual([0]);
	});
});
