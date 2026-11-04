import type { Cast } from "@neynar/nodejs-sdk/build/api";
import type { RunContext } from "../ctx";
import { selfHealFromBackups } from "../lib/backup";
import { getCronFeed, getReplies } from "../lib/neynar";
import {
	drainMissingCasts,
	hasCastInDb,
	processQueuedCast,
	tagCasts,
} from "./read";
import { writeLoop } from "./write";

/**
 * One bounded archiver tick (MIGRATION.md §6.1): the pipeline sliced into a
 * Worker-sized unit with a continuation cursor. Steady state (a couple of
 * new casts) completes in one tick; a deep refresh spans several.
 *
 * Priority order:
 *   1. hydrate conversations for UNKNOWN casts first (new content)
 *   2. tag every feed cast (cheap, idempotent)
 *   3. rotation sweep over the rest of the feed from the cursor (freshness:
 *      every feed cast re-reads its conversations once per ~budget ticks)
 *   4. missing-cast drain, self-heal, renders (skip-if-rendered makes this
 *      near-free in steady state)
 * All index mutations are deferred and flushed as ONE PUT at the end; a
 * crashed tick loses only the buffered index (objects persist; the next
 * tick re-tags by re-crawl).
 */
export interface TickOptions {
	/** Max feed casts whose conversations are hydrated this tick. */
	hydrateBudget?: number;
	/** Wall-clock budget for the tick (ms). Default 8 min. */
	tickMs?: number;
	/** Render cutoff: castsLoop stops starting new renders past this time. */
	renderDeadline?: number;
}

export interface TickResult {
	feedCasts: number;
	unknown: number;
	hydrated: number;
	/** Cursor position into the feed list for the rotation sweep. */
	offset: number;
	renders: number;
	scanned: number;
	failures: number;
}

const CURSOR_KEY = (fid: number): string => `tick_cursor:${fid}`;

export const runTick = async (
	fid: number,
	ctx: RunContext,
	options?: TickOptions,
): Promise<TickResult> => {
	const hydrateBudget = options?.hydrateBudget ?? 40;
	const deadline = Date.now() + (options?.tickMs ?? 8 * 60_000);
	const renderDeadline = options?.renderDeadline;

	await ctx.data.deferCommits();
	let all: Cast[] = [];
	let unknown = 0;
	let hydrated = 0;
	let failures = 0;
	let offset = 0;
	let renders = 0;
	let scanned = 0;
	try {
		const casts = await getCronFeed(fid);
		const replies = await getReplies(fid);
		all = [...casts.casts, ...replies.casts];

		// Identify unknown casts BEFORE tagging (tagging makes them known).
		const unknownCasts: Cast[] = [];
		for (const cast of all) {
			if (!(await hasCastInDb(cast.hash, ctx))) unknownCasts.push(cast);
		}
		unknown = unknownCasts.length;

		await tagCasts(all, ctx);

		// 1. unknown-first hydration (new content beats the freshness sweep)
		for (const cast of unknownCasts) {
			if (hydrated >= hydrateBudget || Date.now() > deadline) break;
			hydrated += 1;
			try {
				await processQueuedCast(cast, true, ctx);
			} catch (error) {
				failures += 1;
				console.error(
					`tick: hydration failed for ${cast.hash}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		// 2. rotation sweep over the feed from the cursor position
		const cursorRaw = await ctx.data.getSetting(CURSOR_KEY(fid));
		const listLen = Math.max(1, all.length);
		offset = cursorRaw !== undefined ? Number(cursorRaw) || 0 : 0;
		let swept = 0;
		while (
			hydrated < hydrateBudget &&
			Date.now() <= deadline &&
			swept < all.length
		) {
			const cast = all[offset % listLen] as Cast;
			offset = (offset + 1) % listLen;
			swept += 1;
			hydrated += 1;
			try {
				await processQueuedCast(cast, true, ctx);
			} catch (error) {
				failures += 1;
				console.error(
					`tick: sweep failed for ${cast.hash}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		await ctx.data.setSetting(CURSOR_KEY(fid), String(offset));

		await drainMissingCasts(2, ctx);
		await selfHealFromBackups("out", ctx);
		const renderResult = await writeLoop("out", ctx, renderDeadline);
		renders = renderResult.written;
		scanned = renderResult.scanned;
	} finally {
		await ctx.data.flushCommits();
	}

	return {
		feedCasts: all.length,
		unknown,
		hydrated,
		offset,
		renders,
		scanned,
		failures,
	};
};
