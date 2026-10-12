import { describe, expect, test } from "bun:test";
import { resetTimers, timeAsync, timerReport } from "./timers";

describe("timeAsync", () => {
	test("passes through the wrapped result", async () => {
		resetTimers();
		const value = await timeAsync("op", async () => 42);
		expect(value).toBe(42);
	});

	test("counts invocations and accumulates time", async () => {
		resetTimers();
		await timeAsync("op", async () => {
			await new Promise((r) => setTimeout(r, 5));
		});
		await timeAsync("op", async () => {});
		const report = timerReport();
		expect(report).toContain("op");
		expect(report).toContain("2");
	});

	test("resetTimers clears accumulated data", async () => {
		resetTimers();
		await timeAsync("ephemeral", async () => {});
		resetTimers();
		expect(timerReport()).not.toContain("ephemeral");
	});
});
