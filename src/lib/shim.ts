import { fetcher } from "itty-fetcher";
import type { User } from "./helpers";

const api = fetcher({
	base: "https://shim.artlu.xyz/",
	headers: { Accept: "application/json" },
});

interface PartialShimUser {
	fid: number;
	username: string;
	displayName: string;
	pfpUrl: string;
	bio: string
}

export const getUserFromShim = async (fid: number): Promise<User> => {
	const res = await api.get<{
		success: boolean;
		user: PartialShimUser;
	}>(`/user/${fid}`);
	return {
		fid: res.user.fid,
		username: res.user.username,
		displayName: res.user.displayName,
		avatar: res.user.pfpUrl,
		bio: res.user.bio,
	};
};
