import { Database } from "bun:sqlite";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { type FeedResponseType, getConversation } from "../lib/neynar";

const VERBOSE = false;

const db = new Database("db/queue.db3", { strict: true });
db.prepare("CREATE TABLE IF NOT EXISTS fids (fid INTEGER PRIMARY KEY)").run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS casts (hash TEXT PRIMARY KEY, fid INTEGER)",
).run();

const tagCast = (cast: FeedResponseType["casts"][number]) => {
	if (VERBOSE) console.log(cast.author.fid, cast.hash);
	db.prepare("INSERT INTO fids (fid) VALUES (?) ON CONFLICT DO NOTHING").run(
		cast.author.fid,
	);
	db.prepare(
		"INSERT INTO casts (hash, fid) VALUES (?, ?) ON CONFLICT DO NOTHING",
	).run(cast.hash, cast.author.fid);
};

const renderCast = (cast: FeedResponseType["casts"][number]) => {
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
			for (const p of conversation.conversation.chronological_parent_casts ?? []) {
				tagCast(p);
			}
			for (const dr of conversation.conversation.cast.direct_replies) {
				tagCast(dr);
			}
		}

		if (VERBOSE) console.log(renderCast(c));
	}
};
