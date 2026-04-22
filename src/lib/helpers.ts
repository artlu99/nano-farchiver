export function pluralize(count: number, word: string, plural = `${word}s`) {
	return `${count} ${count === 1 ? word : plural}`;
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
