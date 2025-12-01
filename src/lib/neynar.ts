import { Database } from "bun:sqlite";
import type { Conversation, FeedResponse } from "@neynar/nodejs-sdk/build/api";
import { fetcher } from "itty-fetcher";
import invariant from "tiny-invariant";

const db = new Database("db/cache.db3", { strict: true });
db.prepare(
	"CREATE TABLE IF NOT EXISTS replies (fid INTEGER PRIMARY KEY, data TEXT)",
).run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS conversations (hash TEXT PRIMARY KEY, data TEXT)",
).run();

invariant(process.env.NEYNAR_API_KEY, "NEYNAR_API_KEY is not set");

const api = fetcher({
	base: "https://api.neynar.com/v2",
	headers: {
		"x-api-key": process.env.NEYNAR_API_KEY,
		"User-Agent": "curl/8.5.0",
	},
});

export const getReplies = async (fid: number): Promise<FeedResponse> => {
	// TODO: handle pagination
	const query = db.query(`SELECT data FROM replies WHERE fid = $fid`);
	const cached = (await query.get(fid)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as FeedResponse;
	}
	try {
		const res = await api.get<FeedResponse>(
			`/farcaster/feed/user/replies_and_recasts/?filter=replies&limit=25&fid=${fid}`,
		);
		db.prepare("INSERT INTO replies (fid, data) VALUES (?, ?)").run(
			fid,
			JSON.stringify(res),
		);
		return res;
	} catch (error) {
		// most likely due to rate limiting
		console.error(error);
		throw error;
	}
};

export const getConversation = async (
	hash: string,
): Promise<Conversation> => {
	// TODO: handle pagination
	const query = db.query(`SELECT data FROM conversations WHERE hash = $hash`);
	const cached = (await query.get(hash)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as Conversation;
	}
	try {
		const res = await api.get<Conversation>(
			`/farcaster/cast/conversation/?reply_depth=5&include_chronological_parent_casts=true&limit=50&identifier=${hash}&type=hash`,
		);
		db.prepare("INSERT INTO conversations (hash, data) VALUES (?, ?)").run(
			hash,
			JSON.stringify(res),
		);
		return res;
	} catch (error) {
		console.error(error);
		throw error;
	}
};
