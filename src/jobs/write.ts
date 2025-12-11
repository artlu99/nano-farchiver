import { Database } from "bun:sqlite";
import fs from "node:fs";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { pluralize } from "../lib/helpers";
import {
	renderEmbeds,
	renderReplyFooter,
	renderReplyHeader,
	renderTopLevelHeader,
	renderUserHeader,
} from "../lib/markdown";
import { countReplies, getUserFromFid } from "./read";

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
${renderedCast.parent_hash ? await renderReplyHeader(hydratedCast) : renderTopLevelHeader(hydratedCast)}
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
	fidsLoop();
	castsLoop();
};
