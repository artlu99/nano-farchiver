import { Database } from "bun:sqlite";
import type { Conversation, FeedResponse } from "@neynar/nodejs-sdk/build/api";
import { fetcher } from "itty-fetcher";
import invariant from "tiny-invariant";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const db = new Database("db/cache.db3", { strict: true });
db.prepare(
	"CREATE TABLE IF NOT EXISTS casts (fid INTEGER PRIMARY KEY, data TEXT)",
).run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS replies (fid INTEGER PRIMARY KEY, data TEXT)",
).run();
db.prepare(
	"CREATE TABLE IF NOT EXISTS conversations (hash TEXT PRIMARY KEY, data TEXT)",
).run();

invariant(process.env.NEYNAR_API_KEY, "NEYNAR_API_KEY is not set");
invariant(process.env.EOA_PRIVATE_KEY, "EOA_PRIVATE_KEY is not set");

const account = privateKeyToAccount(
	`0x${process.env.EOA_PRIVATE_KEY.replace("0x", "")}`,
);
const walletClient = createWalletClient({
	account,
	transport: http(),
	chain: base,
});
// @ts-expect-error - partial typing of walletClient
const fetchWithPay = wrapFetchWithPayment(fetch, walletClient);
// biome-ignore lint/correctness/noUnusedVariables: placeholder
const x402api = fetcher({
	// @ts-expect-error - partial typing of fetchWithPay 
	fetch: fetchWithPay,
	base: "https://api.neynar.com/v2",
});

const api = fetcher({
	base: "https://api.neynar.com/v2",
	headers: {
		"x-api-key": process.env.NEYNAR_API_KEY,
		"User-Agent": "curl/8.5.0",
	},
});

export const getCronFeed = async (fid: number): Promise<FeedResponse> => {
	// TODO: handle pagination
	const query = db.query(`SELECT data FROM casts WHERE fid = $fid`);
	const cached = (await query.get(fid)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as FeedResponse;
	}

	const res = await api.get<FeedResponse>(
		`/farcaster/feed/user/casts/?limit=150&include_replies=false&fid=${fid}`,
	);
	db.prepare("INSERT INTO casts (fid, data) VALUES (?, ?)").run(
		fid,
		JSON.stringify(res),
	);
	return res;
};

export const getReplies = async (fid: number): Promise<FeedResponse> => {
	// TODO: handle pagination
	const query = db.query(`SELECT data FROM replies WHERE fid = $fid`);
	const cached = (await query.get(fid)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as FeedResponse;
	}

	const res = await api.get<FeedResponse>(
		`/farcaster/feed/user/replies_and_recasts/?filter=replies&limit=50&fid=${fid}`,
	);
	db.prepare("INSERT INTO replies (fid, data) VALUES (?, ?)").run(
		fid,
		JSON.stringify(res),
	);
	return res;
};

export const getConversation = async (hash: string): Promise<Conversation> => {
	// TODO: handle pagination
	const query = db.query(`SELECT data FROM conversations WHERE hash = $hash`);
	const cached = (await query.get(hash)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as Conversation;
	}

	console.log("getting conversation for", hash);
	const res = await api.get<Conversation>(
		`/farcaster/cast/conversation/?reply_depth=5&include_chronological_parent_casts=true&limit=50&identifier=${hash}&type=hash`,
	);
	db.prepare("INSERT INTO conversations (hash, data) VALUES (?, ?)").run(
		hash,
		JSON.stringify(res),
	);
	return res;
};
