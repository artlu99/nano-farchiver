import type { Message } from "@farcaster/core";
import { fetcher } from "itty-fetcher";
import { retry, sift } from "radash";

const PAGE_SIZE = 100;
const MAX_SIZE = 1000;

// Note: The snap.farcaster.xyz API returns 2x the requested pageSize (up to 200 messages)
// This appears to be intentional API behavior, not a bug. We handle this by checking
// the actual message count rather than assuming we'll get exactly PAGE_SIZE.

const api = fetcher({
	base: "https://snap.farcaster.xyz:3381/v1",
	headers: { Accept: "application/json" },
});

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

			const messages = sift(
				res.messages.filter((r) => r.data?.castAddBody),
			);
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
): Promise<{ fid: number | undefined; hash: string }[]> => {
	const seen = new Map<string, number>();
	const queue = [{ fid, hash }];
	while (queue.length > 0) {
		const next = queue.shift();
		if (!next) {
			break;
		}
		const { fid, hash } = next;
		if (seen.get(hash)) {
			continue;
		}
		seen.set(hash, fid ?? 0);
		const children = await getChildren(fid ?? 0, hash);
		queue.push(...children);
	}
	return [...seen.entries()].map(([hash, fid]) => ({ fid, hash }));
};
