import type {
	Cast,
	Embed,
	EmbedUrl,
	EmbedUrlMetadata,
} from "@neynar/nodejs-sdk/build/api";
import {
	drainMissingCasts,
	getCastFromHash,
	getUserFromFid,
} from "../jobs/read";
import { renderCast } from "../jobs/write";
import { hash2filename, normalizeHash, pluralize } from "./helpers";

const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;
const QUOTE_PREVIEW_LENGTH = 200;

export const renderUserHeader = async (fid: number): Promise<string> => {
	const user = await getUserFromFid(fid);
	return `
username: ${user.username ?? "unknown"}
fid: ${user.fid}
display name: ${user.displayName ?? "unknown"}
PFP: ${user.avatar ? `[${user.avatar}](${user.avatar})` : "unknown"}
bio: ${user.bio ?? "unknown"}

${user.avatar ? `<img src="${user.avatar}" height="100" width="100" alt="${user.displayName ?? "unknown"}" />` : "no avatar"}
    `.trim();
};

export const renderTopLevelHeader = async (cast: Cast): Promise<string> => {
	const renderedCast = await renderCast(cast);
	return `
---
hash: ${renderedCast.hash.replace(/^0x/, "")}
timestamp: ${renderedCast.timestamp}
fid: ${renderedCast.fid}
---
[${renderedCast.username}](../_users_/${renderedCast.username}.md)
		`.trim();
};

export const castArchiveRelativePath = async (
	hash: string,
	fid: number,
): Promise<string | "<deleted>" | undefined> => {
	const quotedCast = getCastFromHash(hash, fid);
	if (!quotedCast) return undefined;

	const user = await getUserFromFid(fid);
	if (!user?.username) return undefined;

	if (!quotedCast.timestamp) return "<deleted>";

	return `../${user.username}/${hash2filename(hash, quotedCast.timestamp)}`;
};

export const renderReplyHeader = async (cast: Cast): Promise<string> => {
	const renderedCast = await renderCast(cast);
	let parentCast =
		renderedCast.parent_fid && renderedCast.parent_hash
			? getCastFromHash(renderedCast.parent_hash, renderedCast.parent_fid)
			: undefined;
	if (!parentCast && renderedCast.parent_hash) {
		await drainMissingCasts(5);
		parentCast =
			renderedCast.parent_fid && renderedCast.parent_hash
				? getCastFromHash(renderedCast.parent_hash, renderedCast.parent_fid)
				: undefined;
	}
	const parentUser = renderedCast.parent_fid
		? await getUserFromFid(renderedCast.parent_fid)
		: undefined;

	const parentCastPath =
		renderedCast.parent_fid && renderedCast.parent_hash
			? await castArchiveRelativePath(
					renderedCast.parent_hash,
					renderedCast.parent_fid,
				)
			: undefined;

	const frontmatter = [
		`hash: ${renderedCast.hash.replace(/^0x/, "")}`,
		`timestamp: ${renderedCast.timestamp}`,
		`fid: ${renderedCast.fid}`,
	];
	if (renderedCast.parent_fid != null) {
		frontmatter.push(`parent_fid: ${renderedCast.parent_fid}`);
	}
	if (renderedCast.parent_hash) {
		frontmatter.push(
			`parent_hash: ${renderedCast.parent_hash.replace(/^0x/, "")}`,
		);
	}
	if (cast.thread_hash) {
		frontmatter.push(
			`root_parent_hash: ${cast.thread_hash.replace(/^0x/, "")}`,
		);
	}

	return `
---
${frontmatter.join("\n")}
---
[${renderedCast.username}](../_users_/${renderedCast.username}.md)
replying to: [${parentUser?.username ?? "unknown"}](${parentCastPath})
		`.trim();
};

export const renderReplyFooter = (numReplies: number): string => {
	if (numReplies === 0) {
		return "";
	}
	return `
--
${pluralize(numReplies, "Reply", "Replies")}
		`.trim();
};

type CastEmbedRef = { fid: number; hash: string; inlineCast?: Cast };

const getCastEmbedRef = (embed: Embed): CastEmbedRef | undefined => {
	if ("cast" in embed && embed.cast) {
		const inlineCast = embed.cast as unknown as Cast;
		return {
			fid: inlineCast.author.fid,
			hash: inlineCast.hash,
			inlineCast,
		};
	}
	if ("cast_id" in embed && embed.cast_id) {
		return { fid: embed.cast_id.fid, hash: embed.cast_id.hash };
	}
	return undefined;
};

const getOgTitle = (metadata: EmbedUrlMetadata): string | undefined =>
	metadata.html?.ogTitle?.trim() || undefined;

const getOgDescription = (metadata: EmbedUrlMetadata): string | undefined =>
	metadata.html?.ogDescription?.trim() || undefined;

const getPreviewImage = (
	embed: EmbedUrl,
	metadata: EmbedUrlMetadata,
	alt: string,
): string | undefined => {
	const ogImage = metadata.html?.ogImage?.[0];
	const src = ogImage?.url ?? (isImageOnlyUrl(embed) ? embed.url : undefined);
	if (!src) return undefined;

	const height = metadata.image?.height_px;
	const width = metadata.image?.width_px;
	const heightAttr = height ? ` height="${height}"` : "";
	const widthAttr = width ? ` width="${width}"` : "";
	return `<img src="${src}"${heightAttr}${widthAttr} alt="${alt}" />`;
};

const isEmbedUrl = (embed: Embed): embed is EmbedUrl => "url" in embed;

const isImageOnlyUrl = (embed: EmbedUrl): boolean => {
	const image = embed.metadata?.image;
	if (!image) return false;
	const ogImageUrl = embed.metadata?.html?.ogImage?.[0]?.url;
	if (ogImageUrl && ogImageUrl === embed.url) return true;
	return IMAGE_URL_RE.test(embed.url);
};

const urlEmbedLabel = (url: string): string => {
	try {
		const parsed = new URL(url);
		const path = `${parsed.pathname}${parsed.search}`;
		if (path && path !== "/") {
			const pathDisplay = path.startsWith("/") ? path.slice(1) : path;
			return `${parsed.host}/${pathDisplay}`;
		}
		return parsed.host;
	} catch {
		return url;
	}
};

const renderUrlOnly = (embed: EmbedUrl): string =>
	`[${urlEmbedLabel(embed.url)}](${embed.url})`;

const renderImageEmbed = (embed: EmbedUrl): string =>
	`![embedded image](${embed.url})`;

const renderOgCard = (embed: EmbedUrl): string => {
	const metadata = embed.metadata;
	if (!metadata) return renderUrlOnly(embed);

	if (isImageOnlyUrl(embed)) return renderImageEmbed(embed);

	const title = getOgTitle(metadata);
	const description = getOgDescription(metadata);
	const lines: string[] = [];

	if (title) {
		lines.push(`[${title}](${embed.url})`);
		if (description) lines.push(`_${description}_`);
	} else if (description) {
		const label =
			description.length > 80
				? `${description.slice(0, 80)}…`
				: description;
		lines.push(`[${label}](${embed.url})`);
	} else {
		lines.push(renderUrlOnly(embed));
	}

	const img = getPreviewImage(embed, metadata, title || "preview");
	if (img) lines.push(img);

	return lines.join("\n");
};

const renderUrlEmbed = (embed: EmbedUrl): string => {
	const metadata = embed.metadata;
	if (
		!metadata ||
		(!getOgTitle(metadata) &&
			!getOgDescription(metadata) &&
			!metadata.image &&
			!metadata.html?.ogImage?.length)
	) {
		return renderUrlOnly(embed);
	}
	return renderOgCard(embed);
};

const quotePreviewText = (text: string | undefined): string => {
	if (!text?.trim()) return "(empty cast)";
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= QUOTE_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, QUOTE_PREVIEW_LENGTH)}…`;
};

const farcasterQuoteUrl = (hash: string, username: string): string => {
	const h = normalizeHash(hash);
	return `https://farcaster.xyz/${username}/${h}`;
};

const renderQuoteEmbed = async (embed: Embed): Promise<string> => {
	const ref = getCastEmbedRef(embed);
	if (!ref) return renderUnknownEmbed(embed);

	const quotedCast =
		ref.inlineCast ?? getCastFromHash(ref.hash, ref.fid);
	const user = await getUserFromFid(ref.fid);
	const username = user.username ?? `fid:${ref.fid}`;
	const archivePath = await castArchiveRelativePath(ref.hash, ref.fid);

	if (archivePath && archivePath !== "<deleted>") {
		const preview = quotePreviewText(quotedCast?.text);
		return `> quote: [@${username}](${archivePath})\n> ${preview}`;
	}

	const hashPrefix = normalizeHash(ref.hash).slice(0, 10);
	const linkLabel = `${hashPrefix}…`;
	const externalUrl = farcasterQuoteUrl(ref.hash, username);

	if (archivePath === "<deleted>" || !quotedCast) {
		const preview =
			archivePath === "<deleted>"
				? "(deleted or unavailable)"
				: "*(not archived)*";
		return `> quote: [${linkLabel}](${externalUrl})\n> ${preview}`;
	}

	const preview = quotePreviewText(quotedCast.text);
	return `> quote: [${linkLabel}](${externalUrl})\n> ${preview}`;
};

const renderUnknownEmbed = (embed: Embed): string => {
	const json = JSON.stringify(embed);
	const truncated = json.length > 200 ? `${json.slice(0, 200)}…` : json;
	return `{unknown embed: ${truncated}}`;
};

const renderEmbed = async (embed: Embed): Promise<string> => {
	if (getCastEmbedRef(embed)) {
		return renderQuoteEmbed(embed);
	}
	if (isEmbedUrl(embed)) {
		return renderUrlEmbed(embed);
	}
	return renderUnknownEmbed(embed);
};

export const renderEmbedsAsync = async (embeds: Embed[]): Promise<string> => {
	if (!embeds.length) return "";
	const lines = await Promise.all(embeds.map((embed) => renderEmbed(embed)));
	return lines.filter((line) => line.trim().length > 0).join("\n\n");
};

/** @deprecated use renderEmbedsAsync — sync URL-only helper for tests */
export const renderEmbeds = (embeds: Embed[]): string => {
	if (!embeds.length) return "";
	return embeds
		.map((embed) => (isEmbedUrl(embed) ? renderUrlEmbed(embed) : ""))
		.filter((line) => line.trim().length > 0)
		.join("\n\n");
};

export const embedsMissingFromFile = (
	existing: string,
	embeds: Embed[],
	renderedEmbeds: string,
): boolean => {
	if (!embeds.length || !renderedEmbeds.trim()) return false;
	return !existing.includes(renderedEmbeds.trim());
};
