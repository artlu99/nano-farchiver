import type { Cast } from "@neynar/nodejs-sdk/build/api";

let seq = 0;

export const makeHash = (): string => {
	seq += 1;
	return `0x${seq.toString(16).padStart(4, "0")}${"a".repeat(36)}`;
};

export const makeAuthor = (overrides: Record<string, unknown> = {}) => ({
	fid: 3319217,
	username: "artlu",
	display_name: "artlu",
	pfp_url: "https://example.com/pfp.png",
	profile: { bio: { text: "bio" } },
	...overrides,
});

export const makeCast = (overrides: Record<string, unknown> = {}): Cast => {
	const hash = (overrides.hash as string | undefined) ?? makeHash();
	return {
		hash,
		object: "cast",
		text: "hello",
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
		author: makeAuthor(overrides.author as Record<string, unknown> | undefined),
	} as unknown as Cast;
};

export const makeReply = (parent: Cast): Cast =>
	makeCast({
		parent_hash: parent.hash,
		parent_author: { fid: parent.author.fid },
	});

export const withQuoteEmbed = (quoted: Cast, bareHash = false): Cast =>
	makeCast({
		embeds: [
			{
				cast_id: {
					fid: quoted.author.fid,
					hash: bareHash ? quoted.hash.replace(/^0x/, "") : quoted.hash,
				},
			},
		],
	});
