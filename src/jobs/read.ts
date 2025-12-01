import { Database } from "bun:sqlite";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { hardcodedUsers, type User } from "../lib/helpers";
import { getConversation } from "../lib/neynar";
import { renderCast } from "./write";

const VERBOSE = false;

const db = new Database("db/queue.db3", { strict: true });
db.prepare(
	"CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, username TEXT, displayName TEXT, avatar TEXT, bio TEXT)",
).run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS casts (hash TEXT PRIMARY KEY, fid INTEGER, data TEXT)",
).run();


export const getUserFromFid = (fid: number): User => {
	if (hardcodedUsers[fid]) {
		return hardcodedUsers[fid];
	}
	const user = db
		.query(
			"SELECT fid, username, displayName, avatar, bio FROM users WHERE fid = ?",
		)
		.get(fid) as User | undefined;
	if (!user) {
		throw new Error(`User with fid ${fid} not found in database`);
	}
	return user;
};

export const getCastFromHash = (fid: number, hash: string): Cast |undefined=> {
	const cast = db
		.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
		.get(hash, fid) as { data: string } | undefined;
	if (!cast) {
		console.error(`Cast with hash ${hash} not found in database`);
		return undefined;
	}
	return JSON.parse(cast.data) as Cast;
};

const tagCast = (cast: Cast) => {
	if (VERBOSE) console.log(cast.author.fid, cast.hash);
	db.prepare(
		"INSERT INTO users (fid, username, displayName, avatar, bio) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
	).run(
		cast.author.fid,
		cast.author.username ?? null,
		cast.author.display_name ?? null,
		cast.author.pfp_url ?? null,
		cast.author.profile.bio.text ?? null,
	);
	db.prepare(
		"INSERT INTO casts (hash, fid, data) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
	).run(cast.hash, cast.author.fid, JSON.stringify(cast));
};

export const queueLoop = async (casts: Cast[]) => {
	for (const c of casts) {
		tagCast(c);

		if (c.thread_hash) {
			const conversation = await getConversation(c.thread_hash);
			tagCast(conversation.conversation.cast);
			if (VERBOSE) {
				console.log(
					(conversation.conversation.chronological_parent_casts ?? []).length,
				);
				console.log(conversation.conversation.cast.direct_replies.length);
				console.log(conversation.next?.cursor ?? "no cursor");
			}
			for (const p of conversation.conversation.chronological_parent_casts ??
				[]) {
				tagCast(p);
			}
			for (const dr of conversation.conversation.cast.direct_replies) {
				tagCast(dr);
			}
		}

		if (VERBOSE) console.log(renderCast(c));
	}
};
