import {
	createStoreRunContext,
	defaultRunContext,
	type RunContext,
} from "./ctx";
import { drainMissingCasts, queueLoop } from "./jobs/read";
import { writeLoop } from "./jobs/write";
import { selfHealFromBackups } from "./lib/backup";
import { ARCHIVER_FID } from "./lib/config";
import { pluralize } from "./lib/helpers";
import { getCronFeed, getReplies } from "./lib/neynar";
import { resetTimers, timeAsync, timerReport } from "./lib/timers";
import { S3Store, s3ConfigFromEnv } from "./store/s3";

const FID = ARCHIVER_FID;
const FULL_CONVERSATIONS_MODE = true;

/**
 * Backend selection: `ARCHIVE_BACKEND=store` runs the whole pipeline against
 * the S3-compatible bucket (casts/out/index + renders as objects); anything
 * else keeps today's local SQLite + out/ behavior. The single-writer flip
 * (MIGRATION.md stage 3) is setting this env in one deployment.
 */
const runContext = (): RunContext => {
	if (process.env.ARCHIVE_BACKEND === "store") {
		return createStoreRunContext(new S3Store(s3ConfigFromEnv()));
	}
	return defaultRunContext();
};

export const doIt = async (fid: number, ctx: RunContext = runContext()) => {
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
