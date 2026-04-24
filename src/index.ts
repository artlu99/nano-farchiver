import { drainMissingCasts, queueLoop } from "./jobs/read";
import { writeLoop } from "./jobs/write";
import { pluralize } from "./lib/helpers";
import { getCronFeed, getReplies } from "./lib/neynar";

const FID = 3319217;
const FULL_CONVERSATIONS_MODE = true;

export const doIt = async (fid: number) => {
	try {
		const casts = await getCronFeed(fid);
		const replies = await getReplies(fid);
		console.log(pluralize(casts.casts.length, "cast"));
		console.log(casts.next?.cursor ?? "no cursor");
		console.log(pluralize(replies.casts.length, "reply", "replies"));
		console.log(replies.next?.cursor ?? "no cursor");
		await queueLoop(
			[...casts.casts, ...replies.casts],
			FULL_CONVERSATIONS_MODE,
		);
		// Drain any queued missing-cast lookups. Bounded to avoid runaway.
		await drainMissingCasts(5);
		await writeLoop();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		throw error;
	}
};

if (import.meta.main) doIt(FID);
