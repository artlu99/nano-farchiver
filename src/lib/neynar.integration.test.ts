import { expect, test } from "bun:test";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { fetcher } from "itty-fetcher";
import { renderCast } from "../jobs/write";
import { renderEmbedsAsync } from "./markdown";

const api = fetcher({
	base: "https://haatz.quilibrium.com/v2",
	headers: { "User-Agent": "curl/8.5.0" },
});

const fetchCastByHash = async (hash: string): Promise<Cast> => {
	const res = await api.get<{ result: { casts: Cast[] } } | { casts: Cast[] }>(
		`/farcaster/casts/?casts=${hash}`,
	);

	const casts =
		(res && typeof res === "object" && "result" in res
			? res.result?.casts
			: res.casts) ?? [];

	expect(casts).toHaveLength(1);
	// biome-ignore lint/style/noNonNullAssertion: length asserted above (repo convention)
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
	},
	{
		hash: "0x74d1fce60b05199c8eab57d649145d69b258708b",
		fid: 3319217,
		expectedEmbed:
			"[sassyhash.artlu.xyz/blog/developer-journey/](https://sassyhash.artlu.xyz/blog/developer-journey/)",
	},
] as const;

for (const entry of cases) {
	const { hash, fid } = entry;
	test(`GET /farcaster/casts fetches ${hash} (fid ${fid})`, async () => {
		const cast = await fetchCastByHash(hash);

		expect(cast.author.fid).toBe(fid);
		expect(cast.hash).toBe(hash.replace(/^0x/, ""));

		if ("expectedText" in entry) {
			const rendered = await renderCast(cast);
			expect(rendered.text).toContain(entry.expectedText);
		}

		if ("expectedEmbed" in entry) {
			expect(cast.embeds?.length).toBeGreaterThan(0);
			const embedBlock = await renderEmbedsAsync(cast.embeds ?? []);
			expect(embedBlock).toContain(entry.expectedEmbed);
		}
	});
}
