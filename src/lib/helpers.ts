import type { Cast } from "@neynar/nodejs-sdk/build/api";

export function pluralize(count: number, word: string, plural = `${word}s`) {
	return `${count} ${count === 1 ? word : plural}`;
}

export function quoteHashes(cast: Cast): string[] {
	const hashes: string[] = [];
	for (const embed of cast.embeds ?? []) {
		if (
			"cast_id" in embed &&
			embed.cast_id &&
			typeof embed.cast_id.hash === "string"
		) {
			hashes.push(normalizeHash(embed.cast_id.hash));
		}
	}
	return hashes;
}

export function absentHashes(requested: string[], returned: Cast[]): string[] {
	if (requested.length === 0) return [];
	const returnedSet = new Set(returned.map((cast) => normalizeHash(cast.hash)));
	return requested.filter((hash) => !returnedSet.has(normalizeHash(hash)));
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export const normalizeHash = (hash: string) => {
	return hash.startsWith("0x") ? hash : `0x${hash}`;
};

/** The no-0x form used by hash-bearing bucket keys and filenames. */
export const strip0x = (hash: string): string => hash.replace(/^0x/, "");

/** Shared retry backoff: exponential, capped at 30 s (neynar + snapchain). */
export const expBackoff = (i: number): number => Math.min(1000 * 2 ** i, 30000);

export interface User {
	username: string | null;
	fid: number;
	avatar: string | null;
	displayName: string | null;
	bio: string | null;
}

export function hash2filename(hash: string, timestamp: string | Date): string {
	const h = normalizeHash(hash);
	const unixTimestamp = new Date(timestamp);
	const dtString = unixTimestamp.toISOString().slice(0, 10).replace(/-/g, "");
	const tmString = unixTimestamp
		.toISOString()
		.slice(11, 19)
		.replace(/[-:]/g, "");
	return `${dtString}-${tmString}-${h.slice(2, 10)}.md`;
}
