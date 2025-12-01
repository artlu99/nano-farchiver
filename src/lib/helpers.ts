export function pluralize(count: number, word: string, plural = `${word}s`) {
	return `${count} ${count === 1 ? word : plural}`;
}

export interface User {
	username: string | null;
	fid: number;
	avatar: string | null;
	displayName: string | null;
	bio: string | null;
}

export const hardcodedUsers: Record<number, User> = {
	6806: {
		username: "dawufi",
		fid: 6806,
		avatar:
			"https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/406101e5-2c23-4890-e6c9-26fc2dc03600/original",
		displayName: "dawufi",
		bio: "vibe architect",
	},
};