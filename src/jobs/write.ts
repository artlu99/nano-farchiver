import { Database } from "bun:sqlite";
import fs from "node:fs";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { hash2filename, normalizeHash, pluralize } from "../lib/helpers";
import {
	renderEmbeds,
	renderReplyFooter,
	renderReplyHeader,
	renderTopLevelHeader,
	renderUserHeader,
} from "../lib/markdown";
import {
	countReplies,
	getUserFromFid,
	hydrateReferencedParents,
	isCastDeleted,
} from "./read";
import { getUserFromShim } from "../lib/shim";

const OUT_DIR = "out";
const USERS_DIR = `${OUT_DIR}/_users_`;

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
				const profile = mentions.find(({ profile }) => profile.fid === fid)
					?.profile;
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

const db = new Database("db/queue.db3", { strict: true });

export const renderCast = async (cast: Cast) => {
	// TODO: quote casts
	// TODO: embeds

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

export const fidsLoop = async () => {
	if (!fs.existsSync(USERS_DIR)) {
		fs.mkdirSync(USERS_DIR, { recursive: true });
	}

	const fids = db.query("SELECT fid FROM users").all() as { fid: number }[];
	console.log(pluralize(fids.length, "fid"));

	for (const fid of fids) {
		const user = await getUserFromFid(fid.fid);
		if (!user) {
			continue;
		}
		const userPath = `${USERS_DIR}/${user.username}.md`;
		if (fs.existsSync(userPath)) {
			continue;
		}

		console.log("writing user to", userPath);
		fs.writeFileSync(userPath, await renderUserHeader(fid.fid));
		const userCastHashes = (
			db.query("SELECT hash FROM casts WHERE fid = ?").all(user.fid) as {
				hash: string;
			}[]
		).map((h) => h.hash);
		fs.appendFileSync(
			userPath,
			`\n---\n${userCastHashes.map((h) => h.replace(/^0x/, "")).join("\n")}`,
		);
	}
};

export const castsLoop = async () => {
	const casts = db.query("SELECT hash, fid, data FROM casts").all() as {
		hash: string;
		fid: number;
		data: string;
	}[];
	console.log(pluralize(casts.length, "cast"));
	for (const cast of casts) {
		const { fid, hash } = cast;
		const user = await getUserFromFid(fid);
		if (!user) {
			continue;
		}
		const hydratedCast = JSON.parse(cast.data) as Cast;
		// create /out/user.username subdirectory if it doesn't exist yet
		const userSubdir = `${OUT_DIR}/${user.username}`;
		if (!fs.existsSync(userSubdir)) {
			fs.mkdirSync(userSubdir, { recursive: true });
		}

		const castPath = `${userSubdir}/${hash2filename(hash, hydratedCast.timestamp)}`;
		if (fs.existsSync(castPath)) {
			const existing = fs.readFileSync(castPath, "utf8");
			// Only rewrite files that previously had an unresolved parent pointer.
			if (!existing.includes("<deleted>")) continue;
			const renderedCast = await renderCast(hydratedCast);
			if (renderedCast.parent_hash && isCastDeleted(renderedCast.parent_hash)) {
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
${renderedCast.text}
${renderEmbeds(hydratedCast.embeds ?? [])}
${renderReplyFooter(replyCount)}
--
${renderedCast.channel ? `${renderedCast.channel} <img src="${renderedCast.channel_image}" height="20" width="20" alt="${renderedCast.channel}" />` : "{no channel}"}

`.trim(),
		);
	}
};

export const writeLoop = async () => {
	await fidsLoop();
	// Ensure all referenced parent casts exist before writing files.
	await hydrateReferencedParents(5);
	await castsLoop();
	// One more pass to write user files discovered during cast hydration/writes.
	await fidsLoop();
};
