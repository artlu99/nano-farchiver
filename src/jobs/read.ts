import { Database } from "bun:sqlite";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { cluster } from "radash";
import { normalizeHash, type User } from "../lib/helpers";
import { getCasts, getConversation } from "../lib/neynar";
import { getUserFromShim } from "../lib/shim";
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

const missingCastHashes = new Set<string>();

const hasCastInDb = (hash: string): boolean => {
	const with0x = normalizeHash(hash);
	const without0x = with0x.replace(/^0x/, "");
	const row =
		(db.query("SELECT 1 as one FROM casts WHERE hash = ?").get(with0x) as
			| { one: 1 }
			| undefined) ??
		(db.query("SELECT 1 as one FROM casts WHERE hash = ?").get(without0x) as
			| { one: 1 }
			| undefined);
	return !!row;
};

export const getUserFromFid = async (fid: number): Promise<User> => {
	const user = db
		.query(
			"SELECT fid, username, displayName, avatar, bio FROM users WHERE fid = ?",
		)
		.get(fid) as User | undefined;
	if (!user) {
		try {
			const user = await getUserFromShim(fid);
			return user;
		} catch (e) {
			throw new Error(
				`User with fid ${fid} not found in database: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	return user;
};

export const getCastFromHash = (
	hash: string,
	fid: number | undefined,
): Cast | undefined => {
	const with0x = normalizeHash(hash);
	const without0x = with0x.replace(/^0x/, "");
	const cast = fid
		? ((db
				.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
				.get(with0x, fid) as { data: string } | undefined) ??
			(db
				.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
				.get(without0x, fid) as { data: string } | undefined))
		: ((db.query("SELECT data FROM casts WHERE hash = ?").get(with0x) as
				| { data: string }
				| undefined) ??
			(db.query("SELECT data FROM casts WHERE hash = ?").get(without0x) as
				| { data: string }
				| undefined));
	if (!cast) {
		console.error(`Cast with hash ${hash} [${fid}] not found in database`);
		missingCastHashes.add(with0x);
		return undefined;
	}
	return JSON.parse(cast.data) as Cast;
};

export const hydrateMissingCasts = async (): Promise<number> => {
	const hashes = Array.from(missingCastHashes);
	if (hashes.length === 0) return 0;

	missingCastHashes.clear();
	await Promise.all(cluster(hashes, 25).map((chunk) => getCasts(chunk)));
	for (const hash of hashes) {
		if (!hasCastInDb(hash)) {
			missingCastHashes.add(hash);
		}
	}
	return hashes.length;
};

export const getMissingCastCount = (): number => missingCastHashes.size;

export const drainMissingCasts = async (
	maxRounds: number = 5,
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const hydrated = await hydrateMissingCasts();
		total += hydrated;
		if (hydrated === 0) break;
	}
	return total;
};

export const hydrateReferencedParents = async (
	maxRounds: number = 5,
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const missingParents = (
			db
				.query(
					`
SELECT DISTINCT parent_hash as hash
FROM casts
WHERE parent_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM casts c2 WHERE c2.hash = casts.parent_hash)
`,
				)
				.all() as { hash: string }[]
		).map((r) => r.hash);

		if (missingParents.length === 0) break;

		total += missingParents.length;
		await Promise.all(
			cluster(missingParents, 25).map((chunk) => getCasts(chunk)),
		);
	}
	return total;
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
	const normalizedHash = normalizeHash(cast.hash);
	const normalizedParentHash = cast.parent_hash
		? normalizeHash(cast.parent_hash)
		: cast.parent_hash;

	if (VERBOSE) console.log(cast.author.fid, normalizedHash);
	// If this cast was previously observed missing, clear it now that it's present.
	missingCastHashes.delete(normalizedHash);
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
		normalizedHash,
		cast.author.fid,
		JSON.stringify(cast),
		cast.parent_author?.fid,
		normalizedParentHash,
	);
};

export const queueLoop = async (
	casts: Cast[],
	fullConversationsMode: boolean = true,
) => {
	for (const c of casts) {
		tagCast(c);

		if (fullConversationsMode && c.thread_hash) {
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

		if (fullConversationsMode) {
			const replies = await getConversation(c.hash);
			tagCast(replies.conversation.cast);

			for (const p of replies.conversation.chronological_parent_casts ?? []) {
				tagCast(p);
			}

			for (const dr of replies.conversation.cast.direct_replies) {
				tagCast(dr);
			}
		}
		if (VERBOSE) console.log(renderCast(c));
	}
};
