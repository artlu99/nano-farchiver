import type { Message } from "@farcaster/core";
import { fetcher } from "itty-fetcher";
import { retry, sift } from "radash";
import { timeAsync } from "./timers";

const PAGE_SIZE = 100;
const MAX_SIZE = 1000;

// Note: The snap.farcaster.xyz API returns 2x the requested pageSize (up to 200 messages)
// This appears to be intentional API behavior, not a bug. We handle this by checking
// the actual message count rather than assuming we'll get exactly PAGE_SIZE.

const api = fetcher({
	base: "https://snap.farcaster.xyz:3381/v1",
	headers: { Accept: "application/json" },
});

// ---------------------------------------------------------------------------
// Purge-related endpoints. The gateway returns protobuf messages as plain JSON:
// `data` is a decoded object, `hash`/`signer` are 0x-hex strings, `signature`
// is base64, and schemes are enum-name strings. TS proto types don't match at
// runtime, so these fetchers use their own JSON shapes.
// ---------------------------------------------------------------------------

export interface SnapCastId {
	fid: number;
	hash: string;
}

export interface SnapMessageData {
	type: string;
	fid: number;
	timestamp: number; // seconds since FARCASTER_EPOCH
	network: string;
	castAddBody?: {
		text?: string;
		parentCastId?: SnapCastId | null;
		parentUrl?: string | null;
		embeds?: ({ url?: string | null } | { castId?: SnapCastId | null })[];
		mentions?: number[];
		mentionsPositions?: number[];
	};
	reactionBody?: {
		type: string; // "REACTION_TYPE_LIKE" | "REACTION_TYPE_RECAST"
		targetCastId?: SnapCastId | null;
		targetUrl?: string | null;
	};
}

export interface SnapMessage {
	data: SnapMessageData;
	hash: string;
	hashScheme: string;
	signature: string;
	signatureScheme: string;
	signer: string;
}

export interface SnapSignerEvent {
	type: string; // "EVENT_TYPE_SIGNER"
	blockNumber: number;
	signerEventBody: {
		key: string;
		keyType: number;
		eventType: string; // "SIGNER_EVENT_TYPE_ADD" | "SIGNER_EVENT_TYPE_REMOVE"
	};
}

const isEndPageToken = (token: string | undefined): boolean => {
	if (!token) return true;
	try {
		return Buffer.from(token, "base64").toString("utf-8") === "[null,null]";
	} catch {
		return true;
	}
};

const fetchAllSnapMessages = async (
	path: string,
	params: Record<string, string | number | boolean>,
	maxMessages: number,
): Promise<SnapMessage[]> => {
	const all: SnapMessage[] = [];
	let pageToken: string | undefined;
	for (;;) {
		const query: Record<string, string | number | boolean> = {
			...params,
			pageSize: PAGE_SIZE,
		};
		if (pageToken) query.pageToken = pageToken;
		const res = await retry(
			{ times: 5, backoff: (i) => Math.min(1000 * 2 ** i, 30000) },
			() =>
				api.get<{ messages?: SnapMessage[]; nextPageToken?: string }>(path, {
					query,
				}),
		);
		all.push(...(res.messages ?? []));
		if (isEndPageToken(res.nextPageToken) || all.length >= maxMessages) {
			return all.slice(0, maxMessages);
		}
		pageToken = res.nextPageToken;
	}
};

export const snapCastsByFid = (
	fid: number,
	maxMessages = 50_000,
): Promise<SnapMessage[]> =>
	fetchAllSnapMessages("/castsByFid", { fid, reverse: true }, maxMessages);

export const snapReactionsByFid = (
	fid: number,
	reactionType: "Like" | "Recast",
	maxMessages = 200_000,
): Promise<SnapMessage[]> =>
	fetchAllSnapMessages(
		"/reactionsByFid",
		{ fid, reaction_type: reactionType },
		maxMessages,
	);

export const snapCastById = async (
	fid: number,
	hash: string,
): Promise<SnapMessage | null> => {
	try {
		return await api.get<SnapMessage>("/castById", { query: { fid, hash } });
	} catch (error) {
		if (error && typeof error === "object" && "status" in error) {
			const status = (error as { status?: number }).status;
			if (status === 404 || status === 400) return null;
		}
		throw error;
	}
};

/** Does `fid` have a `reactionType` reaction on cast `targetHash`? Early-exits on hit. */
export const snapHasReaction = async (
	fid: number,
	targetHash: string,
	reactionType: "Like" | "Recast",
): Promise<boolean> => {
	const normalized = targetHash.startsWith("0x")
		? targetHash
		: `0x${targetHash}`;
	let pageToken: string | undefined;
	for (;;) {
		const query: Record<string, string | number | boolean> = {
			target_fid: fid,
			target_hash: normalized,
			reaction_type: reactionType,
			pageSize: PAGE_SIZE,
		};
		if (pageToken) query.pageToken = pageToken;
		const res = await retry(
			{ times: 5, backoff: (i) => Math.min(1000 * 2 ** i, 30000) },
			() =>
				api.get<{ messages?: SnapMessage[]; nextPageToken?: string }>(
					"/reactionsByTarget",
					{ query },
				),
		);
		for (const msg of res.messages ?? []) {
			if (msg.data?.fid === fid) return true;
		}
		if (isEndPageToken(res.nextPageToken)) return false;
		pageToken = res.nextPageToken;
	}
};

export const snapOnChainSigners = async (
	fid: number,
): Promise<SnapSignerEvent[]> => {
	const res = await retry(
		{ times: 5, backoff: (i) => Math.min(1000 * 2 ** i, 30000) },
		() =>
			api.get<{ events?: SnapSignerEvent[] }>("/onChainSignersByFid", {
				query: { fid, pageSize: 100 },
			}),
	);
	return res.events ?? [];
};

export const snapSubmitMessage = async (
	messageBytes: Uint8Array,
): Promise<void> => {
	const res = await fetch("https://snap.farcaster.xyz:3381/v1/submitMessage", {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: Buffer.from(messageBytes),
	});
	if (res.ok) return;
	const detail = await res.text().catch(() => "");
	throw new Error(
		`submitMessage failed: HTTP ${res.status} ${detail.slice(0, 300)}`,
	);
};

const getCastsByParent = async (fid: number, hash: string) => {
	const allMessages: Message[] = [];
	let pageToken: string | undefined;
	let hasMore = true;

	while (hasMore && allMessages.length < MAX_SIZE) {
		const fetchPage = async () => {
			const queryParams: Record<string, string | number | boolean> = {
				fid,
				hash,
				pageSize: PAGE_SIZE,
				reverse: false,
			};
			if (pageToken) {
				queryParams.pageToken = pageToken;
			}

			const res = await api.get<{
				messages: Message[];
				nextPageToken?: string;
			}>(`/castsByParent`, {
				query: queryParams,
			});

			return res;
		};

		try {
			const res = await retry(
				{
					times: 5,
					backoff: (i) => Math.min(1000 * 2 ** i, 30000), // Exponential backoff, max 30s
				},
				fetchPage,
			);

			const messages = sift(res.messages.filter((r) => r.data?.castAddBody));
			allMessages.push(...messages);

			// Get the page token
			const newPageToken = res.nextPageToken;

			// Decode the token to check if it's the end token
			// The API returns base64-encoded "[null,null]" when there are no more pages
			let isEndToken = false;
			if (newPageToken) {
				try {
					const decodedToken = Buffer.from(newPageToken, "base64").toString(
						"utf-8",
					);
					isEndToken = decodedToken === "[null,null]";
				} catch {
					// If decoding fails, treat as invalid token (end of pagination)
					isEndToken = true;
				}
			} else {
				// No token means no more pages
				isEndToken = true;
			}

			// Update pageToken for next iteration
			pageToken = newPageToken;

			// Determine if there are more pages:
			// - Stop if we got the end token (decodes to [null,null])
			// - Continue if we have a valid token AND got at least PAGE_SIZE messages
			// Note: API returns 2x PAGE_SIZE (up to 200) when there are more pages
			hasMore = !isEndToken && messages.length >= PAGE_SIZE;
		} catch (error) {
			console.error(
				`Error fetching castsByParent page (fid: ${fid}, hash: ${hash}, pageToken: ${pageToken})`,
				error instanceof Error ? error.message : String(error),
			);
			// Gracefully return what we have so far
			break;
		}
	}

	return allMessages;
};

const getChildren = async (
	fid: number,
	hash: string,
): Promise<{ fid: number | undefined; hash: string }[]> => {
	const childrenCastMessages = await getCastsByParent(fid, hash);
	return childrenCastMessages.map((c) => ({
		fid: c.data?.fid,
		hash: c.hash.toString(),
	}));
};

export const traverse = async (
	fid: number | undefined,
	hash: string,
	getChildrenFn: (
		fid: number,
		hash: string,
	) => Promise<{ fid: number | undefined; hash: string }[]> = (f, h) =>
		timeAsync("traverse", () => getChildren(f, h)),
): Promise<{ fid: number | undefined; hash: string }[]> => {
	const seen = new Map<string, number>();
	let frontier: { fid: number | undefined; hash: string }[] = [{ fid, hash }];
	while (frontier.length > 0) {
		const levels = await Promise.all(
			frontier.map(async (node) => {
				if (seen.has(node.hash)) {
					return [];
				}
				seen.set(node.hash, node.fid ?? 0);
				return getChildrenFn(node.fid ?? 0, node.hash);
			}),
		);
		frontier = levels.flat();
	}
	return [...seen.entries()].map(([hash, fid]) => ({ fid, hash }));
};
