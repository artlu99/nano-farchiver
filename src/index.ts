import { queueLoop } from "./jobs/read";
import { writeLoop } from "./jobs/write";
import { pluralize } from "./lib/helpers";
import { getCronFeed, getReplies } from "./lib/neynar";

const FID = 6546;

const doIt = async (fid: number) => {
	try {
		const casts = await getCronFeed(fid);
		const replies = await getReplies(fid);
		console.log(pluralize(casts.casts.length, "cast"));
		console.log(casts.next?.cursor ?? "no cursor");
		console.log(pluralize(replies.casts.length, "reply", "replies"));
		console.log(replies.next?.cursor ?? "no cursor");
		queueLoop([...casts.casts, ...replies.casts]);
		writeLoop();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		throw error;
	}
};
doIt(FID);
