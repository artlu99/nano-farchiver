import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { cluster } from "radash";
import { mapWithConcurrency } from "../lib/concurrency";
import { getDb } from "../lib/db";
import { normalizeHash, quoteHashes, type User } from "../lib/helpers";
import { getCasts, getConversation } from "../lib/neynar";
import { getUserFromShim } from "../lib/shim";
import { traverse } from "../lib/snapchain";
import { renderCast } from "./write";

const VERBOSE = false;

const missingCastHashes = new Set<string>();

export const isCastDeleted = (hash: string): boolean => {
	const with0x = normalizeHash(hash);
	const row = getDb()
		.query("SELECT 1 as one FROM deleted_casts WHERE hash = ?")
		.get(with0x) as { one: 1 } | undefined;
	return !!row;
};

export const markCastsDeleted = (
	hashes: string[],
	reason: string,
	deletedAt: number = Date.now(),
): number => {
	if (hashes.length === 0) return 0;
	const insert = getDb().prepare(
		"INSERT OR IGNORE INTO deleted_casts (hash, deleted_at, reason) VALUES (?, ?, ?)",
	);
	const tx = getDb().transaction((rows: { hash: string }[]) => {
		for (const r of rows) {
			insert.run(normalizeHash(r.hash), deletedAt, reason);
		}
	});
	tx(hashes.map((hash) => ({ hash })));
	return hashes.length;
};

export const filterNonDeletedCastHashes = (hashes: string[]): string[] => {
	if (hashes.length === 0) return [];
	const normalized = hashes.map(normalizeHash);
	const placeholders = normalized.map(() => "?").join(", ");
	const deleted = getDb()
		.query(`SELECT hash FROM deleted_casts WHERE hash IN (${placeholders})`)
		.all(...normalized) as { hash: string }[];
	const deletedSet = new Set(deleted.map((r) => r.hash));
	return normalized.filter((h) => !deletedSet.has(h));
};

export const hasCastInDb = (hash: string): boolean => {
	const with0x = normalizeHash(hash);
	const without0x = with0x.replace(/^0x/, "");
	if (isCastDeleted(with0x) || isCastDeleted(without0x)) return true;
	const row =
		(getDb().query("SELECT 1 as one FROM casts WHERE hash = ?").get(with0x) as
			| { one: 1 }
			| undefined) ??
		(getDb()
			.query("SELECT 1 as one FROM casts WHERE hash = ?")
			.get(without0x) as { one: 1 } | undefined);
	return !!row;
};

const userCache = new Map<number, User>();

export const clearUserCache = () => {
	userCache.clear();
};

export const getUserFromFid = async (fid: number): Promise<User> => {
	const cached = userCache.get(fid);
	if (cached) return cached;
	const user = getDb()
		.query(
			"SELECT fid, username, displayName, avatar, bio FROM users WHERE fid = ?",
		)
		.get(fid) as User | undefined;
	if (!user) {
		try {
			const shimUser = await getUserFromShim(fid);
			return shimUser;
		} catch (e) {
			throw new Error(
				`User with fid ${fid} not found in database: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	userCache.set(fid, user);
	return user;
};

export const getCastFromHash = (
	hash: string,
	fid: number | undefined,
): Cast | undefined => {
	const with0x = normalizeHash(hash);
	const without0x = with0x.replace(/^0x/, "");
	if (isCastDeleted(with0x) || isCastDeleted(without0x)) {
		return undefined;
	}
	const cast = fid
		? ((getDb()
				.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
				.get(with0x, fid) as { data: string } | undefined) ??
			(getDb()
				.query("SELECT data FROM casts WHERE hash = ? AND fid = ?")
				.get(without0x, fid) as { data: string } | undefined))
		: ((getDb().query("SELECT data FROM casts WHERE hash = ?").get(with0x) as
				| { data: string }
				| undefined) ??
			(getDb().query("SELECT data FROM casts WHERE hash = ?").get(without0x) as
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

export const missingParentHashes = (): string[] =>
	(
		getDb()
			.query(
				`
SELECT DISTINCT parent_hash as hash
FROM casts
WHERE parent_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM casts c2 WHERE c2.hash = casts.parent_hash)
  AND NOT EXISTS (SELECT 1 FROM deleted_casts d WHERE d.hash = casts.parent_hash)
`,
			)
			.all() as { hash: string }[]
	).map((r) => r.hash);

export const hydrateReferencedParents = async (
	maxRounds: number = 5,
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const missingParents = missingParentHashes();

		if (missingParents.length === 0) break;

		total += missingParents.length;
		await Promise.all(
			cluster(missingParents, 25).map((chunk) => getCasts(chunk)),
		);
	}
	return total;
};

export const missingQuotedHashes = (): string[] =>
	(
		getDb()
			.query(
				`
SELECT DISTINCT quoted_hash as hash
FROM cast_quotes
WHERE NOT EXISTS (SELECT 1 FROM casts c WHERE c.hash = cast_quotes.quoted_hash)
  AND NOT EXISTS (SELECT 1 FROM deleted_casts d WHERE d.hash = cast_quotes.quoted_hash)
`,
			)
			.all() as { hash: string }[]
	).map((r) => r.hash);

export const hydrateQuotedCastEmbeds = async (
	maxRounds: number = 5,
): Promise<number> => {
	let total = 0;
	for (let i = 0; i < maxRounds; i++) {
		const missing = missingQuotedHashes();
		if (missing.length === 0) break;
		total += missing.length;
		await Promise.all(cluster(missing, 25).map((chunk) => getCasts(chunk)));
	}
	return total;
};

export const countReplies = (fid: number, hash: string): number => {
	const res = getDb()
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
	getDb()
		.prepare(
			"INSERT INTO users (fid, username, displayName, avatar, bio) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
		)
		.run(
			cast.author.fid,
			cast.author.username ?? null,
			cast.author.display_name ?? null,
			cast.author.pfp_url ?? null,
			cast.author.profile.bio.text ?? null,
		);
	getDb()
		.prepare(
			"INSERT INTO casts (hash, fid, data, parent_fid, parent_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
		)
		.run(
			normalizedHash,
			cast.author.fid,
			JSON.stringify(cast),
			cast.parent_author?.fid,
			normalizedParentHash,
		);
	const quoteInsert = getDb().prepare(
		"INSERT OR IGNORE INTO cast_quotes (cast_hash, quoted_hash) VALUES (?, ?)",
	);
	for (const quoted of quoteHashes(cast)) {
		quoteInsert.run(normalizedHash, quoted);
	}
};

export const tagCasts = (casts: Cast[]) => {
	if (casts.length === 0) return;
	const tx = getDb().transaction((rows: Cast[]) => {
		for (const cast of rows) {
			tagCast(cast);
		}
	});
	tx(casts);
};

const processQueuedCast = async (c: Cast, fullConversationsMode: boolean) => {
	tagCast(c);

	if (!fullConversationsMode) return;

	const phases: Promise<void>[] = [];

	if (c.thread_hash) {
		phases.push(tagThreadConversation(c.thread_hash));
	}

	phases.push(tagReplies(c.hash));

	if (c.parent_author?.fid && c.parent_hash) {
		phases.push(hydrateFullThread(c.parent_author.fid, c.parent_hash));
	} else {
		console.error("No parent author or hash found for cast", c.hash);
	}

	const results = await Promise.allSettled(phases);
	const firstRejected = results.find((r) => r.status === "rejected");
	if (firstRejected) {
		throw (firstRejected as PromiseRejectedResult).reason;
	}
	if (VERBOSE) console.log(await renderCast(c));
};

const tagThreadConversation = async (threadHash: string) => {
	const conversation = await getConversation(threadHash);
	if (VERBOSE) {
		console.log(
			(conversation.conversation.chronological_parent_casts ?? []).length,
		);
		console.log(conversation.conversation.cast.direct_replies.length);
		console.log(conversation.next?.cursor ?? "no cursor");
	}
	tagCasts([
		conversation.conversation.cast,
		...(conversation.conversation.chronological_parent_casts ?? []),
		...conversation.conversation.cast.direct_replies,
	]);
};

const tagReplies = async (hash: string) => {
	const replies = await getConversation(hash);
	tagCasts([
		replies.conversation.cast,
		...(replies.conversation.chronological_parent_casts ?? []),
		...replies.conversation.cast.direct_replies,
	]);
};

const hydrateFullThread = async (fid: number, hash: string) => {
	const fullThread = await traverse(fid, hash);
	await Promise.all(
		cluster(fullThread, 25).map((chunk) =>
			getCasts(chunk.map((item) => item.hash)),
		),
	);
};

export const queueLoop = async (
	casts: Cast[],
	fullConversationsMode: boolean = true,
	concurrency: number = 3,
) => {
	await mapWithConcurrency(casts, concurrency, (c) =>
		processQueuedCast(c, fullConversationsMode),
	);
};
