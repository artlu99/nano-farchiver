import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { expect, test } from "bun:test";
import { fetcher } from "itty-fetcher";
import { renderCast } from "../jobs/write";

const api = fetcher({
	base: "https://haatz.quilibrium.com/v2",
	headers: { "User-Agent": "curl/8.5.0" },
});

const fetchCastByHash = async (hash: string): Promise<Cast> => {
	const res = await api.get<
		{ result: { casts: Cast[] } } | { casts: Cast[] }
	>(`/farcaster/casts/?casts=${hash}`);

	const casts =
		(res && typeof res === "object" && "result" in res
			? res.result?.casts
			: res.casts) ?? [];

	expect(casts).toHaveLength(1);
	return casts[0]!;
};

const cases = [
	{
		hash: "0x41a68fce81633e6e4994d1cd1c17b10078ffbcfe",
		fid: 1325,
		expectedText: "[@unboundbabes](../_users_/unboundbabes.md)",
	},
	{
		hash: "0xd86f491754536a930517c5f6c901cf4df0c91f68",
		fid: 3337563,
		expectedText: "[@adrienne](../_users_/adrienne.md)",
	}
] as const;

for (const { hash, fid, expectedText } of cases) {
	test(`GET /farcaster/casts fetches ${hash} (fid ${fid})`, async () => {
		const cast = await fetchCastByHash(hash);

		expect(cast.author.fid).toBe(fid);
		expect(cast.hash).toBe(hash.replace(/^0x/, ""));

		const rendered = await renderCast(cast);
		expect(rendered.text).toContain(expectedText);
	});
}
