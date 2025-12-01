import { Database } from "bun:sqlite";
import fs from "node:fs";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { pluralize } from "../lib/helpers";
import { countReplies, getCastFromHash, getUserFromFid } from "./read";

const OUT_DIR = "out";
const USERS_DIR = `${OUT_DIR}/_users_`;

const db = new Database("db/queue.db3", { strict: true });

export const renderCast = (cast: Cast) => {
	// TODO: quote casts
	// TODO: embeds
	return {
		hash: cast.hash,
		timestamp: cast.timestamp,
		fid: cast.author?.fid,
		parent_fid: cast.parent_author?.fid ?? undefined,
		parent_hash: cast.parent_hash,

		username: cast.author?.username,

		text: cast.text,

		channel: cast.channel?.name,
		channel_id: cast.channel?.id,
		channel_image: cast.channel?.image_url,
	};
};

const renderTopLevelHeader = (cast: Cast): string => {
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

const renderReplyHeader = (cast: Cast): string => {
	const renderedCast = renderCast(cast);
	const parentCast =
		renderedCast.parent_fid && renderedCast.parent_hash
			? getCastFromHash(renderedCast.parent_fid, renderedCast.parent_hash)
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
		? getUserFromFid(renderedCast.parent_fid)
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

const renderReplyFooter = (numReplies: number): string => {
	if (numReplies === 0) {
		return "";
	}
	return `
--
${pluralize(numReplies, "Reply", "Replies")}
		`.trim();
};

export const fidsLoop = async () => {
	if (!fs.existsSync(USERS_DIR)) {
		fs.mkdirSync(USERS_DIR, { recursive: true });
	}

	const fids = db.query("SELECT fid FROM users").all() as { fid: number }[];
	console.log(pluralize(fids.length, "fid"));

	for (const fid of fids) {
		const user = getUserFromFid(fid.fid);
		if (!user) {
			continue;
		}
		const userPath = `${USERS_DIR}/${user.username}.md`;
		if (fs.existsSync(userPath)) {
			continue;
		}

		console.log("writing user to", userPath);
		fs.writeFileSync(
			userPath,
			`
username: ${user.username ?? "unknown"}
fid: ${user.fid}
display name: ${user.displayName ?? "unknown"}
PFP: ${user.avatar ? `[${user.avatar}](${user.avatar})` : "unknown"}
bio: ${user.bio ?? "unknown"}

${user.avatar ? `<img src="${user.avatar}" height="100" width="100" alt="${user.displayName ?? "unknown"}" />` : "no avatar"}
			`.trim(),
		);
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
		const user = getUserFromFid(fid);
		if (!user) {
			continue;
		}
		const hydratedCast = JSON.parse(cast.data) as Cast;
		const unixTimestamp = new Date(hydratedCast.timestamp);
		// timestamp should by yyyymmdd-hhmmss in local time
		const dtString = unixTimestamp.toISOString().slice(0, 10).replace(/-/g, "");
		const tmString = unixTimestamp
			.toISOString()
			.slice(11, 19)
			.replace(/[-:]/g, "");
		// create /out/user.username subdirectory if it doesn't exist yet
		const userSubdir = `${OUT_DIR}/${user.username}`;
		if (!fs.existsSync(userSubdir)) {
			fs.mkdirSync(userSubdir, { recursive: true });
		}

		const castPath = `${userSubdir}/${dtString}-${tmString}-${hash.slice(2, 10)}.md`;
		if (fs.existsSync(castPath)) {
			continue;
		}
		console.log("writing cast to", castPath);
		const renderedCast = renderCast(hydratedCast);
		const replyCount = countReplies(fid, hash);

		// write
		fs.writeFileSync(
			castPath,
			`
${renderedCast.parent_hash ? renderReplyHeader(hydratedCast) : renderTopLevelHeader(hydratedCast)}
--
${renderedCast.text}
${renderReplyFooter(replyCount)}
--
${renderedCast.channel ? `${renderedCast.channel} <img src="${renderedCast.channel_image}" height="20" width="20" alt="${renderedCast.channel}" />` : "{no channel}"}

`.trim(),
		);
	}
};

export const writeLoop = async () => {
	fidsLoop();
	castsLoop();
};
