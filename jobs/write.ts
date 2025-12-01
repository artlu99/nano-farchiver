import { Database } from "bun:sqlite";
import fs from "node:fs";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { pluralize } from "../lib/helpers";
import { getUserFromFid } from "./read";

const OUT_DIR = "out";
const USERS_DIR = `${OUT_DIR}/_users_`;

const db = new Database("db/queue.db3", { strict: true });

export const renderCast = (cast: Cast) => {
	return {
		timestamp: cast.timestamp,
		hash: cast.hash,
		text: cast.text,
		author: cast.author?.username,
		author_fid: cast.author?.fid,
		parent_author: cast.parent_author?.fid ?? undefined,
		parent_hash: cast.parent_hash,
	};
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
			`\n---\n${userCastHashes.map((h) => h.slice(2, 10)).join("\n")}`,
		);
	}
};

export const castsLoop = async () => {
	const casts = db.query("SELECT hash, fid FROM casts").all() as {
		hash: string;
		fid: number;
	}[];
	console.log(pluralize(casts.length, "cast"));
	for (const cast of casts) {
		const { fid, hash } = cast;
		const user = getUserFromFid(fid);
		if (!user) {
			continue;
		}

		// create /out/user.username subdirectory if it doesn't exist yet
		const userSubdir = `${OUT_DIR}/${user.username}`;
		if (!fs.existsSync(userSubdir)) {
			fs.mkdirSync(userSubdir, { recursive: true });
		}

		const castPath = `${userSubdir}/${hash.slice(2, 10)}.md`;
		if (fs.existsSync(castPath)) {
			continue;
		}
		console.log("writing cast to", castPath);
		fs.writeFileSync(castPath, JSON.stringify(cast));
	}
};

export const writeLoop = async () => {
	fidsLoop();
	castsLoop();
};
