import { Database } from "bun:sqlite";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { cluster } from "radash";
import { hardcodedUsers, type User } from "../lib/helpers";
import { getCasts, getConversation } from "../lib/neynar";
import { traverse } from "../lib/snapchain";
import { renderCast } from "./write";

const VERBOSE = false;

const db = new Database("db/queue.db3", { strict: true });
db.prepare(
	"CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, username TEXT, displayName TEXT, avatar TEXT, bio TEXT)",
).run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS casts (hash TEXT PRIMARY KEY, fid INTEGER, data TEXT, parent_fid INTEGER, parent_hash TEXT)",
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

export const getCastFromHash = (
	hash: string,
	fid: number | undefined,
): Cast | undefined => {
	const cast = fid
		? (db
				.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
				.get(hash, fid) as { data: string } | undefined)
		: (db.query("SELECT data FROM casts WHERE hash = ?").get(hash) as
				| { data: string }
				| undefined);
	if (!cast) {
		console.error(`Cast with hash ${hash} not found in database`);
		return undefined;
	}
	return JSON.parse(cast.data) as Cast;
};

export const countReplies = (fid: number, hash: string): number => {
	const res = db
		.query(
			"SELECT count(1) as count FROM casts WHERE parent_hash = ? AND parent_fid = ?",
		)
		.get(hash, fid) as { count: number } | undefined;
	if (!res) {
		return 0;
	}
	return res.count;
};

export const tagCast = (cast: Cast) => {
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
		"INSERT INTO casts (hash, fid, data, parent_fid, parent_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
	).run(
		cast.hash,
		cast.author.fid,
		JSON.stringify(cast),
		cast.parent_author?.fid,
		cast.parent_hash,
	);
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

			if (c.parent_author?.fid && c.parent_hash) {
				const fullThread = await traverse(c.parent_author.fid, c.parent_hash);
				await Promise.all(
					cluster(fullThread, 25).map((chunk) =>
						getCasts(chunk.map((item) => item.hash)),
					),
				);
			} else {
				console.error("No parent author or hash found for cast", c.hash);
			}
		}

		const replies = await getConversation(c.hash);
		tagCast(replies.conversation.cast);
		for (const p of replies.conversation.chronological_parent_casts ?? []) {
			tagCast(p);
		}
		for (const dr of replies.conversation.cast.direct_replies) {
			tagCast(dr);
		}

		if (VERBOSE) console.log(renderCast(c));
	}
};
