import type {
	Cast,
	Conversation,
	FeedResponse,
} from "@neynar/nodejs-sdk/build/api";
import { fetcher } from "itty-fetcher";
import { diff, sift, unique } from "radash";
import invariant from "tiny-invariant";
import { defaultRunContext, type RunContext } from "../ctx";
import {
	filterNonDeletedCastHashes,
	getCastFromHash,
	hasCastInDb,
	markCastsDeleted,
	tagCasts,
} from "../jobs/read";
import { absentHashes } from "./helpers";
import { withTimeout } from "./timeouts";
import { timeAsync } from "./timers";

const MAX_SIZE = 10000;

// Within-run API cache (formerly db/cache.db3): one archiver run = one memory
// space, so `bun clear` is no longer needed between runs. Nothing here is
// consulted across runs — the persistent archive lives in queue.db3/bucket.
const feedCache = new Map<number, string>();
const repliesCache = new Map<number, string>();
const conversationCache = new Map<string, string>();

export const clearRunCache = (): void => {
	feedCache.clear();
	repliesCache.clear();
	conversationCache.clear();
};

const api = fetcher({
	base: "https://haatz.quilibrium.com/v2",
	headers: { "User-Agent": "curl/8.5.0" },
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
			// Log the error for debugging
			if (i === 0) {
				// Log first attempt error
				if (error && typeof error === "object" && "status" in error) {
					const status = (error as { status?: number }).status;
					const message =
						"message" in error
							? (error as { message?: string }).message
							: "Unknown error";
					console.error(
						`Request failed (attempt ${i + 1}/${options.times}): HTTP ${status} - ${message}`,
					);
				} else {
					console.error(
						`Request failed (attempt ${i + 1}/${options.times}):`,
						error,
					);
				}
			}

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
				console.log(
					`Retrying in ${delay}ms (attempt ${i + 2}/${options.times})...`,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}
	console.error(`All ${options.times} retry attempts failed`);
	throw lastError;
};

/**
 * Helper function to paginate through Neynar API responses using cursor-based pagination
 * Collects all pages up to MAX_SIZE and returns a combined FeedResponse
 */
const paginateFeedResponse = async (
	url: string,
	limit: number,
	baseParams: Record<string, string | number | boolean>,
	ctx: RunContext = defaultRunContext(),
): Promise<FeedResponse> => {
	const allCasts: Cast[] = [];
	let cursor: string | undefined;
	let hasMore = true;
	let firstResponse: FeedResponse | undefined;

	while (hasMore && allCasts.length < MAX_SIZE) {
		const fetchPage = async () => {
			const params: Record<string, string | number | boolean> = {
				...baseParams,
				limit,
			};
			if (cursor) {
				params.cursor = cursor;
			}

			console.log("fetching page:", url, params);
			const res = await api.get<FeedResponse>(url, { query: params });
			return res;
		};

		try {
			const res = await retryWithSkip(
				{
					times: 3,
					backoff: (i) => {
						const delay = Math.min(1000 * 2 ** i, 30000);
						if (i > 0) {
							console.log(`Retrying after ${delay}ms (attempt ${i + 1}/5)`);
						}
						return delay;
					},
				},
				fetchPage,
			);

			// Store first response as template for structure
			if (!firstResponse) {
				firstResponse = res;
			}

			// Check if response has casts
			if (!res.casts || res.casts.length === 0) {
				console.warn(
					`WARNING: Response has no casts! Response keys: ${Object.keys(res).join(", ")}`,
				);
				hasMore = false;
				break;
			}

			allCasts.push(...res.casts);

			// Short-circuit for incremental runs: if the oldest cast on this page
			// is already in the archive, all subsequent pages will be older and known.
			const lastCastOnPage = res.casts.at(-1);
			if (lastCastOnPage && (await hasCastInDb(lastCastOnPage.hash, ctx))) {
				console.log(
					`Stopping pagination: oldest cast on page (${lastCastOnPage.hash.slice(0, 10)}...) already in queue`,
				);
				hasMore = false;
			}

			// Check if there's a next page
			const previousCursor = cursor;
			const newCursor = res.next?.cursor ?? undefined;
			cursor = newCursor;
			hasMore = !!cursor && res.casts.length === limit;

			// Stop if we got fewer than requested (last page)
			if (res.casts.length < limit) {
				hasMore = false;
				console.log(
					`Stopping pagination: got ${res.casts.length} casts (less than ${limit})`,
				);
			}

			// Safety check: if cursor didn't change, we might be stuck in a loop
			if (previousCursor && cursor && previousCursor === cursor) {
				console.warn(
					`WARNING: Cursor didn't change! Previous: ${previousCursor.substring(0, 50)}, New: ${cursor.substring(0, 50)}`,
				);
				hasMore = false; // Stop to avoid infinite loop
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

export const getCronFeed = async (
	fid: number,
	ctx: RunContext = defaultRunContext(),
): Promise<FeedResponse> => {
	// Check cache first
	const cached = feedCache.get(fid);
	if (cached) {
		return JSON.parse(cached) as FeedResponse;
	}

	// Fetch all pages
	const res = await paginateFeedResponse(
		"/farcaster/feed/user/casts/",
		150,
		{
			include_replies: false,
			fid,
		},
		ctx,
	);

	// Cache the complete paginated result
	feedCache.set(fid, JSON.stringify(res));

	return res;
};

export const getReplies = async (
	fid: number,
	ctx: RunContext = defaultRunContext(),
): Promise<FeedResponse> => {
	// Check cache first
	const cached = repliesCache.get(fid);
	if (cached) {
		return JSON.parse(cached) as FeedResponse;
	}

	// Fetch all pages
	const res = await paginateFeedResponse(
		"/farcaster/feed/user/replies_and_recasts/",
		50,
		{
			filter: "replies",
			fid,
		},
		ctx,
	);

	// Cache the complete paginated result
	repliesCache.set(fid, JSON.stringify(res));

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
	const limit = 50;
	let mergedConversation: Conversation | undefined;
	let cursor: string | undefined;
	let hasMore = true;

	while (hasMore) {
		const fetchPage = async () => {
			const params: Record<string, string | number | boolean> = {
				...baseParams,
				limit,
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
			if (replyCount < limit) {
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
	const cached = conversationCache.get(hash);
	if (cached) {
		return JSON.parse(cached) as Conversation;
	}

	console.log("getting conversation for", hash);
	// Fetch all pages
	const res = await timeAsync("conversation", () =>
		paginateConversation("/farcaster/cast/conversation/", {
			reply_depth: 5,
			include_chronological_parent_casts: true,
			identifier: hash,
			type: "hash",
		}),
	);

	// Cache the complete paginated result
	conversationCache.set(hash, JSON.stringify(res));

	return res;
};

/**
 * Fetch casts by hash. `ctx` decides where the results land — cache checks,
 * tombstones, and (critically) the fetched rows themselves all go through
 * `ctx.data`. Never rely on the implicit default here: the prod run context is
 * the bucket, and tagging into the SQLite default instead leaves the bucket
 * index permanently missing rows (the "[parent unavailable]" timeline bug).
 */
export const getCasts = async (
	hashes: string[],
	ctx: RunContext = defaultRunContext(),
): Promise<Cast[]> => {
	invariant(hashes.length > 0, "hashes is empty");
	invariant(hashes.length <= 25, "hashes can't be more than 25 at a time");

	// check cache for each hash
	const cachedCasts = sift(
		await Promise.all(
			hashes.map((hash) => getCastFromHash(hash, undefined, ctx)),
		),
	);
	const seenHashes = unique(cachedCasts.map((cast) => cast.hash));
	const unseenHashes = diff(hashes, seenHashes);

	if (unseenHashes.length > 0) {
		const fetchHashes = await filterNonDeletedCastHashes(unseenHashes, ctx);
		if (fetchHashes.length === 0) return cachedCasts;
		try {
			const res = await timeAsync("casts", () =>
				withTimeout(
					api.get<
						| { result: { casts: Cast[] } }
						| { casts: Cast[] }
						| Record<string, unknown>
					>(`/farcaster/casts/?casts=${fetchHashes.join(",")}`),
					{
						timeoutMs: 5000, // 5 seconds
						timeoutMessage: "Timed out waiting for response (5s)",
						warnAfterMs: 3000, // 3 seconds
						warn: () => {
							for (const hash of fetchHashes) {
								console.log(`still waiting for response for hash ${hash}`);
							}
						},
						onTimeout: () => {
							// Timeout is not proof a cast is gone — leave it missing
							// so later rounds (or runs) retry instead of deleting.
							console.log(
								`casts request timed out; ${fetchHashes.length} hash(es) left for retry`,
							);
						},
					},
				),
			);
			const fetchedCasts =
				(res && typeof res === "object" && "result" in res
					? (res as { result?: { casts?: Cast[] } }).result?.casts
					: (res as { casts?: Cast[] }).casts) ?? [];
			// A successful response that omits a hash is upstream confirming
			// the cast no longer exists — record it as deleted.
			const absent = absentHashes(fetchHashes, fetchedCasts);
			if (absent.length > 0) {
				await markCastsDeleted(absent, "not found upstream", Date.now(), ctx);
			}
			// update cache for unseen hashes
			await tagCasts(fetchedCasts, ctx);
			return [...cachedCasts, ...fetchedCasts];
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
