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
import type { RenderedEntryRef } from "../store/indexModel";
import { embedsFingerprint } from "../store/indexModel";
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
	const sink = ctx.out(outDir);
	const fids = await ctx.data.listUserFids();
	console.log(pluralize(fids.length, "fid"));

	for (const fid of fids) {
		const user = await getUserFromFid(fid, ctx);
		if (!user) {
			continue;
		}
		const userRelPath = `_users_/${user.username}.md`;
		if (await sink.has(userRelPath)) {
			continue;
		}

		console.log("writing user to", `${outDir}/${userRelPath}`);
		const userCastHashes = await ctx.data.listCastHashesByFid(user.fid);
		const content =
			(await renderUserHeader(fid, ctx)) +
			`\n---\n${userCastHashes.map((h) => h.replace(/^0x/, "")).join("\n")}`;
		await sink.write(userRelPath, content);
	}
};

export const castsLoop = async (
	outDir: string = OUT_DIR,
	ctx: RunContext = defaultRunContext(),
) => {
	const sink = ctx.out(outDir);
	const casts = await ctx.data.listCasts();
	const rendered = await ctx.data.listRendered();
	console.log(pluralize(casts.length, "cast"));

	// Render-state updates are batched into one index commit at the end.
	const pendingRendered: RenderedEntryRef[] = [];
	let written = 0;

	for (const { fid, hash, ts } of casts) {
		// Tombstoned casts are never rendered or rewritten — their archived
		// files stay untouched, and re-rendering after a purge is self-heal's job.
		if (await isCastDeleted(hash, ctx)) continue;
		const user = await getUserFromFid(fid, ctx);
		if (!user) {
			continue;
		}
		// original template-literal behavior: null username → "null" directory
		const username = user.username ?? "null";
		const filename = hash2filename(hash, new Date(ts));
		const castRelPath = `${username}/${filename}`;
		const replyCount = await ctx.data.countReplies(fid, hash);

		// Skip-if-rendered WITHOUT fetching the cast object: embeds are
		// protocol-immutable, so a rendered entry with a matching reply count
		// means the file is current. The embeds fingerprint is computed only
		// when we actually render. (Zero `<deleted>` markers exist in the
		// seeded corpus — verified by grep at migration time.)
		const prior = rendered[username]?.[filename];
		if (prior && prior.replyCount === replyCount) {
			continue;
		}

		const hydratedCast = await getCastOrLog(hash, fid, ctx);
		if (!hydratedCast) continue;
		const embedsFp = embedsFingerprint(hydratedCast.embeds ?? []);

		const embedBlock = await renderEmbedsAsync(hydratedCast.embeds ?? [], ctx);
		const existing = await sink.read(castRelPath);
		if (existing !== null) {
			// Store backend: a changed reply count means the footer is stale —
			// re-render even though embeds are unchanged (closes the reply-count
			// staleness gap). fs backend has no prior entry → old criteria only.
			const needsRewrite =
				existing.includes("<deleted>") ||
				embedsMissingFromFile(
					existing,
					hydratedCast.embeds ?? [],
					embedBlock,
				) ||
				(prior !== undefined && prior.replyCount !== replyCount);
			if (!needsRewrite) {
				pendingRendered.push({
					username,
					filename,
					embedsFp,
					replyCount,
				});
				continue;
			}
			if (
				hydratedCast.parent_hash &&
				(await isCastDeleted(hydratedCast.parent_hash, ctx))
			) {
				continue;
			}
		}
		console.log("writing cast to", `${outDir}/${castRelPath}`);
		written += 1;
		const renderedCast = await renderCast(hydratedCast, ctx);

		// write
		await sink.write(
			castRelPath,
			`
${renderedCast.parent_hash ? await renderReplyHeader(hydratedCast, ctx) : await renderTopLevelHeader(hydratedCast, ctx)}
--
${renderedCast.text}${embedBlock ? `\n\n${embedBlock}` : ""}
${renderReplyFooter(replyCount)}
--
${renderedCast.channel ? `${renderedCast.channel} <img src="${renderedCast.channel_image}" height="20" width="20" alt="${renderedCast.channel}" />` : "{no channel}"}

`.trim(),
		);
		pendingRendered.push({
			username,
			filename,
			embedsFp,
			replyCount,
		});
	}

	await ctx.data.markRendered(pendingRendered);
	console.log(
		`renders: ${written} written, ${pendingRendered.length - written} marked current, ${casts.length} scanned`,
	);
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
