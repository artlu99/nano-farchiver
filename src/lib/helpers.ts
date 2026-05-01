export function pluralize(count: number, word: string, plural = `${word}s`) {
	return `${count} ${count === 1 ? word : plural}`;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function utcDayKey(isoTimestamp: string): string {
	const d = new Date(isoTimestamp);
	return d.toISOString().slice(0, 10);
}

export const normalizeHash = (hash: string) => {
	return hash.startsWith("0x") ? hash : `0x${hash}`;
};

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
