import type { Cast } from "@neynar/nodejs-sdk/build/api";
import type { RunContext } from "../ctx";
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
 *   4. missing-cast drain, renders (skip-if-rendered makes this near-free
 *      in steady state)
 * All index mutations are deferred and flushed as ONE PUT at the end; a
 * crashed tick loses only the buffered index (objects persist; the next
 * tick re-tags by re-crawl). Self-heal from backups/ is NOT part of the
 * tick — Workers cannot see local backups/; run `bun run doIt` locally for
 * that (no-op unless a manifest entry is missing).
 */
export interface TickOptions {
	/** Max feed casts whose conversations are hydrated this tick. */
	hydrateBudget?: number;
	/** Wall-clock budget for the tick (ms). Default 8 min. */
	tickMs?: number;
	/** Render cutoff: castsLoop stops starting new renders past this time. */
	renderDeadline?: number;
	/** Progress sink — called on phase changes and per-cast updates. */
	onProgress?: (progress: TickProgress) => void;
}

export type TickPhase =
	| "feeds"
	| "hydrate"
	| "sweep"
	| "drain"
	| "render"
	| "idle";

export interface TickProgress {
	running: boolean;
	fid: number;
	phase: TickPhase;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	hydrateBudget: number;
	hydrated: number;
	unknown: number;
	offset: number;
	renders: number;
	scanned: number;
	failures: number;
	lastLine: string;
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
	const onProgress = options?.onProgress;
	const startedAt = Date.now();

	// Reads the live closure counters — call sites pass only phase + lastLine.
	const progress = (phase: TickPhase, lastLine = ""): void => {
		if (!onProgress) return;
		onProgress({
			running: true,
			fid,
			phase,
			startedAt,
			updatedAt: Date.now(),
			hydrateBudget,
			hydrated,
			unknown,
			offset,
			renders,
			scanned,
			failures,
			lastLine,
		});
	};

	await ctx.data.deferCommits();
	let all: Cast[] = [];
	let unknown = 0;
	let hydrated = 0;
	let failures = 0;
	let offset = 0;
	let renders = 0;
	let scanned = 0;
	try {
		const casts = await getCronFeed(fid, ctx);
		const replies = await getReplies(fid, ctx);
		all = [...casts.casts, ...replies.casts];
		progress("feeds", `feeds: ${all.length} casts in feed`);

		// Identify unknown casts BEFORE tagging (tagging makes them known).
		const unknownCasts: Cast[] = [];
		for (const cast of all) {
			if (!(await hasCastInDb(cast.hash, ctx))) unknownCasts.push(cast);
		}
		unknown = unknownCasts.length;

		await tagCasts(all, ctx);
		progress("hydrate", `tagged ${all.length} casts, ${unknown} new`);

		// 1. unknown-first hydration (new content beats the freshness sweep)
		for (const cast of unknownCasts) {
			if (hydrated >= hydrateBudget || Date.now() > deadline) break;
			hydrated += 1;
			progress("hydrate", `conversation for ${cast.hash.slice(0, 10)}`);
			try {
				await processQueuedCast(cast, true, ctx);
			} catch (error) {
				failures += 1;
				progress("hydrate", `failed: ${cast.hash.slice(0, 10)}`);
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
		progress("sweep", `sweep from offset ${offset}`);
		while (
			hydrated < hydrateBudget &&
			Date.now() <= deadline &&
			swept < all.length
		) {
			const cast = all[offset % listLen] as Cast;
			offset = (offset + 1) % listLen;
			swept += 1;
			hydrated += 1;
			progress("sweep", `sweep ${swept}/${all.length}`);
			try {
				await processQueuedCast(cast, true, ctx);
			} catch (error) {
				failures += 1;
				progress("sweep", `failed: ${cast.hash.slice(0, 10)}`);
				console.error(
					`tick: sweep failed for ${cast.hash}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		await ctx.data.setSetting(CURSOR_KEY(fid), String(offset));

		progress("drain", "draining missing casts");
		await drainMissingCasts(2, ctx);

		progress("render", "rendering");
		const renderResult = await writeLoop(
			"out",
			ctx,
			renderDeadline,
			(line: string) => progress("render", line),
		);
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
