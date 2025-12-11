import type { Cast, Embed, EmbedUrl, EmbedUrlMetadata } from "@neynar/nodejs-sdk/build/api";
import { getCastFromHash, getUserFromFid } from "../jobs/read";
import { renderCast } from "../jobs/write";
import { pluralize } from "./helpers";

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

export const renderTopLevelHeader = (cast: Cast): string => {
	const renderedCast = renderCast(cast);
	return `
---
hash: ${renderedCast.hash.replace(/^0x/, "")}
timestamp: ${renderedCast.timestamp}
fid: ${renderedCast.fid}
---
[${renderedCast.username}](../_users_/${renderedCast.username}.md)
		`.trim();
};

export const renderReplyHeader = async (cast: Cast): Promise<string> => {
	const renderedCast = renderCast(cast);
	const parentCast =
		renderedCast.parent_fid && renderedCast.parent_hash
			? getCastFromHash(renderedCast.parent_hash, renderedCast.parent_fid)
			: undefined;
	const parentCastTimestamp = parentCast?.timestamp;
	const parentDtString = parentCastTimestamp
		? new Date(parentCastTimestamp).toISOString().slice(0, 10).replace(/-/g, "")
		: undefined;
	const parentTmString = parentCastTimestamp
		? new Date(parentCastTimestamp)
				.toISOString()
				.slice(11, 19)
				.replace(/[-:]/g, "")
		: undefined;
	const parentUser = renderedCast.parent_fid
		? await getUserFromFid(renderedCast.parent_fid)
		: undefined;

	const parentCastPath = parentUser
		? parentDtString && parentTmString
			? `../${parentUser.username}/${parentDtString}-${parentTmString}-${renderedCast.parent_hash?.slice(2, 10)}.md`
			: "<deleted>"
		: undefined;

	return `
---
hash: ${renderedCast.hash.replace(/^0x/, "")}
timestamp: ${renderedCast.timestamp}
fid: ${renderedCast.fid}
parent_fid: ${renderedCast.parent_fid}
parent_hash: ${renderedCast.parent_hash?.replace(/^0x/, "")}
root_parent_hash: ${cast.thread_hash?.replace(/^0x/, "")}
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

const isEmbedUrl = (embed: Embed): embed is EmbedUrl => {
	return "url" in embed;
};
const isEmbedUrlImage = (embedUrl: EmbedUrlMetadata): boolean => {
	return "image" in embedUrl;
};
export const renderEmbeds = (embeds: Embed[]): string => {
	return embeds
		.filter(isEmbedUrl)
		.filter((embed) => embed.metadata && isEmbedUrlImage(embed.metadata))
		.map((embed) =>
			`
<img src="${embed.url}" height={${embed.metadata?.image?.height_px}} width={${embed.metadata?.image?.width_px}} alt="embedded image" />
		`.trim(),
		)
		.join("\n");
};
