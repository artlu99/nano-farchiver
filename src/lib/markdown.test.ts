import type { Embed } from "@neynar/nodejs-sdk/build/api";
import { describe, expect, test } from "bun:test";
import {
	embedsMissingFromFile,
	renderEmbeds,
	renderEmbedsAsync,
} from "./markdown";

describe("renderEmbeds", () => {
	test("url_only_embed", () => {
		const embeds: Embed[] = [
			{ url: "https://sassyhash.artlu.xyz/blog/developer-journey/" },
		];
		const out = renderEmbeds(embeds);
		expect(out).toBe(
			"[sassyhash.artlu.xyz/blog/developer-journey/](https://sassyhash.artlu.xyz/blog/developer-journey/)",
		);
		expect(out).not.toContain("<img");
	});

	test("url_with_title_metadata", () => {
		const embeds: Embed[] = [
			{
				url: "https://example.com/article",
				metadata: {
					_status: "ok",
					html: { ogTitle: "Article Title", ogDescription: "Desc" },
				},
			},
		];
		const out = renderEmbeds(embeds);
		expect(out).toContain("[Article Title](https://example.com/article)");
		expect(out).toContain("_Desc_");
	});

	test("url_with_image_metadata", () => {
		const embeds: Embed[] = [
			{
				url: "https://example.com",
				metadata: {
					_status: "ok",
					html: {
						ogTitle: "T",
						ogImage: [{ url: "https://example.com/og.png" }],
					},
					image: { height_px: 200, width_px: 400 },
				},
			},
		];
		const out = renderEmbeds(embeds);
		expect(out).toContain('height="200"');
		expect(out).not.toContain("height={");
		expect(out).toContain('src="https://example.com/og.png"');
	});

	test("image_only_url_extension", () => {
		const embeds: Embed[] = [
			{
				url: "https://cdn.example.com/photo.jpg",
				metadata: {
					_status: "ok",
					image: { height_px: 100, width_px: 100 },
				},
			},
		];
		const out = renderEmbeds(embeds);
		expect(out).toBe("![embedded image](https://cdn.example.com/photo.jpg)");
	});

	test("multiple_embeds_separated", () => {
		const embeds: Embed[] = [
			{ url: "https://a.com" },
			{ url: "https://b.com" },
		];
		const out = renderEmbeds(embeds);
		expect(out).toBe("[a.com](https://a.com)\n\n[b.com](https://b.com)");
	});

	test("empty_embeds", () => {
		expect(renderEmbeds([])).toBe("");
	});

	test("unknown_embed", async () => {
		const embeds = [{ foo: "bar" }] as unknown as Embed[];
		const out = await renderEmbedsAsync(embeds);
		expect(out).toContain("{unknown embed:");
	});
});

describe("embedsMissingFromFile", () => {
	test("detects missing url embed", () => {
		const embeds: Embed[] = [{ url: "https://example.com/x" }];
		const rendered = "[example.com/x](https://example.com/x)";
		expect(embedsMissingFromFile("cast text only", embeds, rendered)).toBe(
			true,
		);
	});

	test("detects stale bare url embed", () => {
		const embeds: Embed[] = [{ url: "https://example.com/x" }];
		const rendered = "[example.com/x](https://example.com/x)";
		expect(
			embedsMissingFromFile(
				"text\n\nhttps://example.com/x",
				embeds,
				rendered,
			),
		).toBe(true);
	});

	test("detects missing quote embed", () => {
		const embeds = [
			{ cast_id: { fid: 1, hash: "0xabc" } },
		] as unknown as Embed[];
		expect(
			embedsMissingFromFile("cast text", embeds, "> quote: [@u](path)"),
		).toBe(true);
	});

	test("no rewrite when embed present", () => {
		const embeds: Embed[] = [{ url: "https://example.com/x" }];
		const rendered = "[example.com/x](https://example.com/x)";
		expect(
			embedsMissingFromFile(
				"text\n\n[example.com/x](https://example.com/x)",
				embeds,
				rendered,
			),
		).toBe(false);
	});
});
