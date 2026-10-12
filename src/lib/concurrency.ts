import { cluster } from "radash";

export const mapWithConcurrency = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> => {
	const results: R[] = [];
	const safeLimit = Math.max(1, limit);
	for (const chunk of cluster(items, safeLimit)) {
		results.push(...(await Promise.all(chunk.map(fn))));
	}
	return results;
};
