import fs from "node:fs";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { defaultRunContext, type RunContext } from "../ctx";
import { hash2filename, normalizeHash, pluralize } from "../lib/helpers";
import {
	embedsMissingFromFile,
	renderEmbedsAsync,
	renderReplyFooter,
	renderReplyHeader,
	renderTopLevelHeader,
	renderUserHeader,
} from "../lib/markdown";
import { getUserFromShim } from "../lib/shim";
import {
	getUserFromFid,
	hydrateQuotedCastEmbeds,
	hydrateReferencedParents,
	isCastDeleted,
} from "./read";

const OUT_DIR = "out";

const PLACEHOLDER_USERNAME = /^fid:\d+$/;

const isPlaceholderUsername = (username: string | null | undefined): boolean =>
	!username?.trim() || PLACEHOLDER_USERNAME.test(username.trim());

const resolveMentionUsername = async (
	profile: Cast["mentioned_profiles"][number],
	ctx: RunContext,
): Promise<string> => {
	const hint = profile.username?.trim();
	if (hint && !isPlaceholderUsername(hint)) return hint;

	try {
		const user = await getUserFromFid(profile.fid, ctx);
		if (user.username && !isPlaceholderUsername(user.username)) {
			return user.username;
		}
	} catch {
		// fall through to shim
	}

	try {
		const user = await getUserFromShim(profile.fid);
		if (user.username && !isPlaceholderUsername(user.username)) {
			return user.username;
		}
	} catch {
		// fall through to placeholder
	}

	return hint || `fid:${profile.fid}`;
};

const mentionLink = (username: string): string =>
	`[@${username}](../_users_/${username}.md)`;

const applyProfileMentions = async (
	text: string,
	profiles: Cast["mentioned_profiles"],
	ranges: Cast["mentioned_profiles_ranges"],
	ctx: RunContext,
): Promise<string> => {
	if (!profiles?.length || !ranges?.length) return text;

	const mentions = profiles
		.map((profile, index) => ({ profile, range: ranges[index] }))
		.filter(
			(
				mention,
			): mention is {
				profile: (typeof profiles)[number];
				range: NonNullable<(typeof ranges)[number]>;
			} => mention.range !== undefined,
		)
		.sort((a, b) => b.range.start - a.range.start);

	const usernameByFid = new Map<number, string>();
	await Promise.all(
		[...new Set(mentions.map(({ profile }) => profile.fid))].map(
			async (fid) => {
				const profile = mentions.find(
					({ profile }) => profile.fid === fid,
				)?.profile;
				if (!profile) return;
				usernameByFid.set(fid, await resolveMentionUsername(profile, ctx));
			},
		),
	);

	let result = text;
	for (const { profile, range } of mentions) {
		const username = usernameByFid.get(profile.fid) ?? `fid:${profile.fid}`;
		result =
			result.slice(0, range.start) +
			mentionLink(username) +
			result.slice(range.end);
	}
	return result;
};

export const renderCast = async (cast: Cast, ctx?: RunContext) => {
	// mentions: ranges[i] marks where mentioned_profiles[i] appears in text
	const textWithMentions = await applyProfileMentions(
		cast.text,
		cast.mentioned_profiles,
		cast.mentioned_profiles_ranges,
		ctx ?? defaultRunContext(),
	);

	return {
		hash: normalizeHash(cast.hash),
		timestamp: cast.timestamp,
		fid: cast.author?.fid,
		parent_fid: cast.parent_author?.fid ?? undefined,
		parent_hash: cast.parent_hash ? normalizeHash(cast.parent_hash) : undefined,

		username: cast.author?.username,

		text: textWithMentions,

		channel: cast.channel?.name,
		channel_id: cast.channel?.id,
		channel_image: cast.channel?.image_url,
	};
};

export const fidsLoop = async (
	outDir: string = OUT_DIR,
	ctx: RunContext = defaultRunContext(),
) => {
	const usersDir = `${outDir}/_users_`;
	if (!fs.existsSync(usersDir)) {
		fs.mkdirSync(usersDir, { recursive: true });
	}

	const fids = await ctx.data.listUserFids();
	console.log(pluralize(fids.length, "fid"));

	for (const fid of fids) {
		const user = await getUserFromFid(fid, ctx);
		if (!user) {
			continue;
		}
		const userPath = `${usersDir}/${user.username}.md`;
		if (fs.existsSync(userPath)) {
			continue;
		}

		console.log("writing user to", userPath);
		fs.writeFileSync(userPath, await renderUserHeader(fid, ctx));
		const userCastHashes = await ctx.data.listCastHashesByFid(user.fid);
		fs.appendFileSync(
			userPath,
			`\n---\n${userCastHashes.map((h) => h.replace(/^0x/, "")).join("\n")}`,
		);
	}
};

export const castsLoop = async (
	outDir: string = OUT_DIR,
	ctx: RunContext = defaultRunContext(),
) => {
	const casts = await ctx.data.listCasts();
	console.log(pluralize(casts.length, "cast"));

	for (const { fid, hash } of casts) {
		// Tombstoned casts are never rendered or rewritten — their archived
		// files stay untouched, and re-rendering after a purge is self-heal's job.
		if (await isCastDeleted(hash, ctx)) continue;
		const user = await getUserFromFid(fid, ctx);
		if (!user) {
			continue;
		}
		const hydratedCast = await getCastOrLog(hash, fid, ctx);
		if (!hydratedCast) continue;
		// create /out/user.username subdirectory if it doesn't exist yet
		const userSubdir = `${outDir}/${user.username}`;
		if (!fs.existsSync(userSubdir)) {
			fs.mkdirSync(userSubdir, { recursive: true });
		}

		const castPath = `${userSubdir}/${hash2filename(hash, hydratedCast.timestamp)}`;
		const embedBlock = await renderEmbedsAsync(hydratedCast.embeds ?? []);
		if (fs.existsSync(castPath)) {
			const existing = fs.readFileSync(castPath, "utf8");
			const needsRewrite =
				existing.includes("<deleted>") ||
				embedsMissingFromFile(existing, hydratedCast.embeds ?? [], embedBlock);
			if (!needsRewrite) continue;
			if (
				hydratedCast.parent_hash &&
				(await isCastDeleted(hydratedCast.parent_hash, ctx))
			) {
				continue;
			}
		}
		console.log("writing cast to", castPath);
		const renderedCast = await renderCast(hydratedCast, ctx);
		const replyCount = await ctx.data.countReplies(fid, hash);

		// write
		fs.writeFileSync(
			castPath,
			`
${renderedCast.parent_hash ? await renderReplyHeader(hydratedCast, ctx) : await renderTopLevelHeader(hydratedCast, ctx)}
--
${renderedCast.text}${embedBlock ? `\n\n${embedBlock}` : ""}
${renderReplyFooter(replyCount)}
--
${renderedCast.channel ? `${renderedCast.channel} <img src="${renderedCast.channel_image}" height="20" width="20" alt="${renderedCast.channel}" />` : "{no channel}"}

`.trim(),
		);
	}
};

const getCastOrLog = async (
	hash: string,
	fid: number,
	ctx: RunContext,
): Promise<Cast | undefined> => {
	const data = await ctx.data.getCastData(hash, fid);
	if (data === undefined) {
		console.error(`Cast with hash ${hash} [${fid}] not found in database`);
		return undefined;
	}
	return JSON.parse(data) as Cast;
};

export const writeLoop = async (
	outDir: string = OUT_DIR,
	ctx: RunContext = defaultRunContext(),
) => {
	await fidsLoop(outDir, ctx);
	// Ensure all referenced parent casts exist before writing files.
	await hydrateReferencedParents(5, ctx);
	await hydrateQuotedCastEmbeds(5, ctx);
	await castsLoop(outDir, ctx);
	// One more pass to write user files discovered during cast hydration/writes.
	await fidsLoop(outDir, ctx);
};
