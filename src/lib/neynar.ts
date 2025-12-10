import { Database } from "bun:sqlite";
import type {
	Cast,
	Conversation,
	FeedResponse,
} from "@neynar/nodejs-sdk/build/api";
import { fetcher } from "itty-fetcher";
import { diff, sift, unique } from "radash";
import invariant from "tiny-invariant";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { getCastFromHash, tagCast } from "../jobs/read";

const PAGE_SIZE = 50; // some queries are limited to 50, so we use that as a limit
const MAX_SIZE = 10000;

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

/**
 * Wrapper for retry that short-circuits on 400 (Bad Request) errors
 * since these are client errors that won't succeed on retry
 */
const retryWithSkip = async <T>(
	options: { times: number; backoff: (i: number) => number },
	fn: () => Promise<T>,
): Promise<T> => {
	let lastError: unknown;
	for (let i = 0; i < options.times; i++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			// Check if it's a 400 error (client error) - don't retry these
			if (
				error &&
				typeof error === "object" &&
				"status" in error &&
				(error as { status?: number }).status === 400
			) {
				console.error(
					"400 Bad Request error detected - skipping retries",
					error,
				);
				throw error;
			}
			// For other errors, wait and retry
			if (i < options.times - 1) {
				const delay = options.backoff(i);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}
	throw lastError;
};

/**
 * Helper function to paginate through Neynar API responses using cursor-based pagination
 * Collects all pages up to MAX_SIZE and returns a combined FeedResponse
 */
const paginateFeedResponse = async (
	url: string,
	baseParams: Record<string, string | number | boolean>,
): Promise<FeedResponse> => {
	const allCasts: Cast[] = [];
	let cursor: string | undefined;
	let hasMore = true;
	let firstResponse: FeedResponse | undefined;

	while (hasMore && allCasts.length < MAX_SIZE) {
		const fetchPage = async () => {
			const params: Record<string, string | number | boolean> = {
				...baseParams,
				limit: PAGE_SIZE,
			};
			if (cursor) {
				params.cursor = cursor;
			}

			const res = await api.get<FeedResponse>(url, { query: params });
			return res;
		};

		try {
			const res = await retryWithSkip(
				{
					times: 5,
					backoff: (i) => Math.min(1000 * 2 ** i, 30000), // Exponential backoff, max 30s
				},
				fetchPage,
			);

			// Store first response as template for structure
			if (!firstResponse) {
				firstResponse = res;
			}

			allCasts.push(...res.casts);

			// Check if there's a next page
			cursor = res.next?.cursor ?? undefined;
			hasMore = !!cursor && res.casts.length === PAGE_SIZE;

			// Stop if we got fewer than requested (last page)
			if (res.casts.length < PAGE_SIZE) {
				hasMore = false;
			}
		} catch (error) {
			console.error(
				`Error fetching paginated page (url: ${url}, cursor: ${cursor})`,
			);
			if (error instanceof Error) {
				console.error("Error message:", error.message);
				console.error("Error stack:", error.stack);
				// Check for additional error properties
				if ("status" in error) {
					console.error("HTTP status:", (error as { status?: number }).status);
				}
				if ("statusText" in error) {
					console.error(
						"HTTP statusText:",
						(error as { statusText?: string }).statusText,
					);
				}
				if ("response" in error) {
					console.error(
						"Response:",
						JSON.stringify((error as { response?: unknown }).response, null, 2),
					);
				}
			} else {
				console.error("Error object:", error);
				console.error("Error stringified:", JSON.stringify(error, null, 2));
			}
			// Gracefully return what we have so far
			break;
		}
	}

	// Return a FeedResponse with all casts combined
	// Use the structure from the first response, but replace casts with all collected casts
	if (!firstResponse) {
		throw new Error("No response received from API");
	}

	return {
		...firstResponse,
		casts: allCasts,
		next: null, // No more pages since we collected them all
	} as unknown as FeedResponse;
};

export const getCronFeed = async (fid: number): Promise<FeedResponse> => {
	// Check cache first
	const query = db.query(`SELECT data FROM casts WHERE fid = $fid`);
	const cached = (await query.get(fid)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as FeedResponse;
	}

	// Fetch all pages
	const res = await paginateFeedResponse("/farcaster/feed/user/casts/", {
		include_replies: false,
		fid,
	});

	// Cache the complete paginated result
	db.prepare("INSERT OR REPLACE INTO casts (fid, data) VALUES (?, ?)").run(
		fid,
		JSON.stringify(res),
	);

	return res;
};

export const getReplies = async (fid: number): Promise<FeedResponse> => {
	// Check cache first
	const query = db.query(`SELECT data FROM replies WHERE fid = $fid`);
	const cached = (await query.get(fid)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as FeedResponse;
	}

	// Fetch all pages
	const res = await paginateFeedResponse(
		"/farcaster/feed/user/replies_and_recasts/",
		{
			filter: "replies",
			fid,
		},
	);

	// Cache the complete paginated result
	db.prepare("INSERT OR REPLACE INTO replies (fid, data) VALUES (?, ?)").run(
		fid,
		JSON.stringify(res),
	);

	return res;
};

/**
 * Helper function to paginate through Conversation responses
 * Merges nested arrays (direct_replies, chronological_parent_casts) across pages
 */
const paginateConversation = async (
	url: string,
	baseParams: Record<string, string | number | boolean>,
): Promise<Conversation> => {
	let mergedConversation: Conversation | undefined;
	let cursor: string | undefined;
	let hasMore = true;

	while (hasMore) {
		const fetchPage = async () => {
			const params: Record<string, string | number | boolean> = {
				...baseParams,
				limit: PAGE_SIZE,
			};
			if (cursor) {
				params.cursor = cursor;
			}

			// Log request details for debugging
			console.log(
				`Fetching conversation page: ${url} with params:`,
				JSON.stringify(params, null, 2),
			);

			const res = await api.get<Conversation>(url, { query: params });
			return res;
		};

		try {
			const res = await retryWithSkip(
				{
					times: 5,
					backoff: (i) => Math.min(1000 * 2 ** i, 30000), // Exponential backoff, max 30s
				},
				fetchPage,
			);

			if (!mergedConversation) {
				// First page - use as base
				mergedConversation = res;
			} else {
				// Merge subsequent pages into the first response
				// Merge direct_replies
				if (res.conversation.cast.direct_replies) {
					mergedConversation.conversation.cast.direct_replies = [
						...(mergedConversation.conversation.cast.direct_replies || []),
						...res.conversation.cast.direct_replies,
					];
				}

				// Merge chronological_parent_casts
				if (res.conversation.chronological_parent_casts) {
					mergedConversation.conversation.chronological_parent_casts = [
						...(mergedConversation.conversation.chronological_parent_casts ||
							[]),
						...res.conversation.chronological_parent_casts,
					];
				}
			}

			// Check if there's a next page
			cursor = res.next?.cursor ?? undefined;
			hasMore = !!cursor;

			// Stop if we got fewer than requested (last page)
			// For conversations, we check if we got a full page of replies
			const replyCount = res.conversation.cast.direct_replies?.length || 0;
			if (replyCount < PAGE_SIZE) {
				hasMore = false;
			}
		} catch (error) {
			console.error(
				`Error fetching paginated conversation page (url: ${url}, cursor: ${cursor})`,
			);
			if (error instanceof Error) {
				console.error("Error message:", error.message);
				console.error("Error stack:", error.stack);
				// Check for additional error properties
				if ("status" in error) {
					console.error("HTTP status:", (error as { status?: number }).status);
				}
				if ("statusText" in error) {
					console.error(
						"HTTP statusText:",
						(error as { statusText?: string }).statusText,
					);
				}
				if ("response" in error) {
					console.error(
						"Response:",
						JSON.stringify((error as { response?: unknown }).response, null, 2),
					);
				}
			} else {
				console.error("Error object:", error);
				console.error("Error stringified:", JSON.stringify(error, null, 2));
			}
			// Gracefully return what we have so far
			break;
		}
	}

	// Clear the next cursor since we've collected all pages
	if (mergedConversation) {
		mergedConversation.next = undefined;
	}

	if (!mergedConversation) {
		throw new Error("Failed to fetch conversation");
	}

	return mergedConversation;
};

export const getConversation = async (hash: string): Promise<Conversation> => {
	// Check cache first
	const query = db.query(`SELECT data FROM conversations WHERE hash = $hash`);
	const cached = (await query.get(hash)) as { data: string } | undefined;
	if (cached) {
		return JSON.parse(cached.data) as Conversation;
	}

	console.log("getting conversation for", hash);
	// Fetch all pages
	const res = await paginateConversation("/farcaster/cast/conversation/", {
		reply_depth: 5,
		include_chronological_parent_casts: true,
		identifier: hash,
		type: "hash",
	});

	// Cache the complete paginated result
	db.prepare(
		"INSERT OR REPLACE INTO conversations (hash, data) VALUES (?, ?)",
	).run(hash, JSON.stringify(res));

	return res;
};

export const getCasts = async (hashes: string[]): Promise<Cast[]> => {
	invariant(hashes.length > 0, "hashes is empty");
	invariant(hashes.length <= 25, "hashes can't be more than 25 at a time");

	// check cache for each hash
	const cachedCasts = sift(
		hashes.map((hash) => getCastFromHash(hash, undefined)),
	);
	const seenHashes = unique(cachedCasts.map((cast) => cast.hash));
	const unseenHashes = diff(hashes, seenHashes);

	if (unseenHashes.length > 0) {
		try {
			const res = await api.get<{ result: { casts: Cast[] } }>(
				`/farcaster/casts/?casts=${unseenHashes.join(",")}`,
			);
			// update cache for unseen hashes
			for (const cast of res.result.casts) {
				tagCast(cast);
			}
			return [...cachedCasts, ...res.result.casts];
		} catch (error: unknown) {
			console.error(
				"Error getting casts",
				(error as { statusText?: string })?.statusText ??
					(error as Error)?.message,
			);
			return cachedCasts;
		}
	}
	return cachedCasts;
};
