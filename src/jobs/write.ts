import type { SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { getDb } from "../lib/db";
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
	countReplies,
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
): Promise<string> => {
	const hint = profile.username?.trim();
	if (hint && !isPlaceholderUsername(hint)) return hint;

	try {
		const user = await getUserFromFid(profile.fid);
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
				usernameByFid.set(fid, await resolveMentionUsername(profile));
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

export const renderCast = async (cast: Cast) => {
	// mentions: ranges[i] marks where mentioned_profiles[i] appears in text
	const textWithMentions = await applyProfileMentions(
		cast.text,
		cast.mentioned_profiles,
		cast.mentioned_profiles_ranges,
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

export const fidsLoop = async (outDir: string = OUT_DIR) => {
	const usersDir = `${outDir}/_users_`;
	if (!fs.existsSync(usersDir)) {
		fs.mkdirSync(usersDir, { recursive: true });
	}

	const fids = getDb().query("SELECT fid FROM users").all() as {
		fid: number;
	}[];
	console.log(pluralize(fids.length, "fid"));

	for (const fid of fids) {
		const user = await getUserFromFid(fid.fid);
		if (!user) {
			continue;
		}
		const userPath = `${usersDir}/${user.username}.md`;
		if (fs.existsSync(userPath)) {
			continue;
		}

		console.log("writing user to", userPath);
		fs.writeFileSync(userPath, await renderUserHeader(fid.fid));
		const userCastHashes = (
			getDb().query("SELECT hash FROM casts WHERE fid = ?").all(user.fid) as {
				hash: string;
			}[]
		).map((h) => h.hash);
		fs.appendFileSync(
			userPath,
			`\n---\n${userCastHashes.map((h) => h.replace(/^0x/, "")).join("\n")}`,
		);
	}
};

export const castsLoop = async (outDir: string = OUT_DIR) => {
	const total = (
		getDb().query("SELECT count(1) as n FROM casts").get() as { n: number }
	).n;
	console.log(pluralize(total, "cast"));

	const PAGE_SIZE = 500;
	let cursor: string | undefined;
	for (;;) {
		const params: SQLQueryBindings[] = [];
		let sql = "SELECT hash, fid, data FROM casts";
		if (cursor !== undefined) {
			sql += " WHERE hash > ?";
			params.push(cursor);
		}
		sql += " ORDER BY hash LIMIT ?";
		params.push(PAGE_SIZE);
		const rows = getDb()
			.query(sql)
			.all(...params) as {
			hash: string;
			fid: number;
			data: string;
		}[];
		if (rows.length === 0) break;

		for (const { fid, hash, data } of rows) {
			cursor = hash;
			const user = await getUserFromFid(fid);
			if (!user) {
				continue;
			}
			const hydratedCast = JSON.parse(data) as Cast;
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
					embedsMissingFromFile(
						existing,
						hydratedCast.embeds ?? [],
						embedBlock,
					);
				if (!needsRewrite) continue;
				if (
					hydratedCast.parent_hash &&
					isCastDeleted(hydratedCast.parent_hash)
				) {
					continue;
				}
			}
			console.log("writing cast to", castPath);
			const renderedCast = await renderCast(hydratedCast);
			const replyCount = countReplies(fid, hash);

			// write
			fs.writeFileSync(
				castPath,
				`
${renderedCast.parent_hash ? await renderReplyHeader(hydratedCast) : await renderTopLevelHeader(hydratedCast)}
--
${renderedCast.text}${embedBlock ? `\n\n${embedBlock}` : ""}
${renderReplyFooter(replyCount)}
--
${renderedCast.channel ? `${renderedCast.channel} <img src="${renderedCast.channel_image}" height="20" width="20" alt="${renderedCast.channel}" />` : "{no channel}"}

`.trim(),
			);
		}
		if (rows.length < PAGE_SIZE) break;
	}
};

export const writeLoop = async (outDir: string = OUT_DIR) => {
	await fidsLoop(outDir);
	// Ensure all referenced parent casts exist before writing files.
	await hydrateReferencedParents(5);
	await hydrateQuotedCastEmbeds(5);
	await castsLoop(outDir);
	// One more pass to write user files discovered during cast hydration/writes.
	await fidsLoop(outDir);
};
