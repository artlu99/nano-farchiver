import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
	test("processes all items and preserves result order", async () => {
		const out = await mapWithConcurrency(
			[1, 2, 3, 4, 5, 6, 7],
			3,
			async (x) => {
				await new Promise((r) => setTimeout(r, (7 - x) % 3));
				return x * 2;
			},
		);
		expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
	});

	test("never exceeds the concurrency limit", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight -= 1;
		});
		expect(maxInFlight).toBeLessThanOrEqual(3);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	test("handles empty input", async () => {
		const out = await mapWithConcurrency([], 3, async (x: number) => x);
		expect(out).toEqual([]);
	});

	test("clamps non-positive limits to 1", async () => {
		const out = await mapWithConcurrency([1, 2, 3], 0, async (x) => x * 10);
		expect(out).toEqual([10, 20, 30]);
	});

	test("propagates worker errors", async () => {
		await expect(
			mapWithConcurrency([1, 2], 2, async (x) => {
				if (x === 2) throw new Error("boom");
				return x;
			}),
		).rejects.toThrow("boom");
	});
});
