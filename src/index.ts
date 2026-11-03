import { type RunContext, runtimeContext } from "./ctx";
import { drainMissingCasts, queueLoop } from "./jobs/read";
import { writeLoop } from "./jobs/write";
import { selfHealFromBackups } from "./lib/backup";
import { ARCHIVER_FID } from "./lib/config";
import { pluralize } from "./lib/helpers";
import { getCronFeed, getReplies } from "./lib/neynar";
import { resetTimers, timeAsync, timerReport } from "./lib/timers";

const FID = ARCHIVER_FID;
const FULL_CONVERSATIONS_MODE = true;

/**
 * The writer pipeline: fetch upstream → tag → heal → render → R2.
 * Runs on the hourly cron via scripts/cron-store-archiver.sh (flock-enforced
 * single writer).
 */
export const doIt = async (fid: number, ctx: RunContext = runtimeContext()) => {
	await ctx.data.deferCommits();
	try {
		resetTimers();
		const casts = await getCronFeed(fid);
		const replies = await getReplies(fid);
		console.log(pluralize(casts.casts.length, "cast"));
		console.log(casts.next?.cursor ?? "no cursor");
		console.log(pluralize(replies.casts.length, "reply", "replies"));
		console.log(replies.next?.cursor ?? "no cursor");
		await timeAsync("queueLoop", () =>
			queueLoop(
				[...casts.casts, ...replies.casts],
				FULL_CONVERSATIONS_MODE,
				3,
				ctx,
			),
		);
		// Drain any queued missing-cast lookups. Bounded to avoid runaway.
		await drainMissingCasts(5, ctx);
		await timeAsync("selfHeal", () => selfHealFromBackups("out", ctx));
		await timeAsync("writeLoop", () => writeLoop("out", ctx));
		console.log(`\ntimers:\n${timerReport()}`);
	} finally {
		// Store backend: ~300 in-run index mutations coalesce into one PUT.
		// On a crashed run the flush is skipped — objects remain, the next
		// run re-tags them into the index (self-healing by re-crawl).
		await ctx.data.flushCommits();
	}
};

if (import.meta.main) doIt(FID);
