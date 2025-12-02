import type { Message } from "@farcaster/core";
import { fetcher } from "itty-fetcher";
import { sift } from "radash";

const api = fetcher({
	base: "https://snap.farcaster.xyz:3381/v1",
	headers: { Accept: "application/json" },
});

const getCastsByParent = async (fid: number, hash: string) => {
	// TODO: handle pagination
	const res = await api.get<{ messages: Message[] }>(`/castsByParent`, {
		query: {
			fid,
			hash,
			pageSize: 100,
			reverse: false,
		},
	});
	return sift(res.messages.filter((r) => r.data?.castAddBody));
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
