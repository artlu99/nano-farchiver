import { Database } from "bun:sqlite";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { type FeedResponseType, getConversation } from "../lib/neynar";
import { renderCast } from "./write";

const VERBOSE = false;

const db = new Database("db/queue.db3", { strict: true });
db.prepare(
	"CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, username TEXT, displayName TEXT, avatar TEXT, bio TEXT)",
).run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS casts (hash TEXT PRIMARY KEY, fid INTEGER, data TEXT)",
).run();

interface User {
	username: string | null;
	fid: number;
	avatar: string | null;
	displayName: string | null;
	bio: string | null;
}

export const getUserFromFid = (fid: number): User => {
	const user = db
		.query(
			"SELECT fid, username, displayName, avatar, bio FROM users WHERE fid = ?",
		)
		.get(fid) as User | undefined;
	if (!user) {
		return {
			username: `!${fid}`,
			fid,
			avatar: null,
			displayName: `unknown user ${fid}`,
			bio: null,
		}
	}
	return user;
};

const tagCast = (cast: FeedResponseType["casts"][number]) => {
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
