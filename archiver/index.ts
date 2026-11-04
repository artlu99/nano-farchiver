import type { RunContext } from "../src/ctx";
import { StoreArchiveData } from "../src/data/store";
import { runTick, type TickResult, tickCursorKey } from "../src/jobs/tick";
import { StoreRenderSink } from "../src/sink";
import {
	getJSON,
	runRequestKey,
	runStatusKey,
	settingKey,
	writeRunStatus,
} from "../src/store/indexModel";
import { S3Store } from "../src/store/s3";

/**
 * Archiver worker: runs the archive pipeline on Cloudflare.
 *
 *   POST /runs          200 {result} — acquires the run lock and executes one
 *                       bounded tick synchronously; 409 if a run is active.
 *   GET  /runs/status   {running, takenAt, cursorOffset}
 *   scheduled (cron)    same tick, hourly.
 *
 * Single-writer: a lock object in the bucket (`meta/lock`, create-only with a
 * 30-minute takeover for crashed runs). Overlapping invocations lose the
 * lock race and no-op. The tick is bounded; a crashed tick loses only the
 * buffered index (objects persist; the next tick re-tags by re-crawl).
 */

export interface Env {
	S3_ENDPOINT: string;
	S3_BUCKET: string;
	S3_REGION?: string;
	S3_ACCESS_KEY_ID: string;
	S3_SECRET_ACCESS_KEY: string;
	ARCHIVER_FID?: string;
	HYDRATE_BUDGET?: string;
	TICK_MS?: string;
}

const LOCK_KEY = "meta/lock";
const LOCK_TTL_MS = 30 * 60_000;

const archiverFid = (env: Env): number => Number(env.ARCHIVER_FID ?? 3319217);

let store: S3Store | undefined;
let ctx: RunContext | undefined;

const getStore = (env: Env): S3Store => {
	store ??= new S3Store({
		endpoint: env.S3_ENDPOINT,
		bucket: env.S3_BUCKET,
		region: env.S3_REGION ?? "auto",
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
	});
	return store;
};

const getCtx = (env: Env): RunContext => {
	ctx ??= {
		data: new StoreArchiveData(getStore(env)),
		missingCastHashes: new Set(),
		userCache: new Map(),
		out: () => new StoreRenderSink(getStore(env)),
	};
	return ctx;
};

interface LockState {
	takenAt: number;
}

/** Create-only lock; stale locks (>30 min, crashed run) are taken over. */
const acquireLock = async (env: Env): Promise<LockState | "busy"> => {
	const s = getStore(env);
	const takenAt = Date.now();
	try {
		await s.put(LOCK_KEY, JSON.stringify({ takenAt }), { ifNoneMatch: "*" });
		return { takenAt };
	} catch {
		const obj = await s.get(LOCK_KEY);
		if (!obj) return acquireLock(env); // vanished between put and get — retry
		let existing = 0;
		try {
			existing =
				Number(JSON.parse(new TextDecoder().decode(obj.body)).takenAt) || 0;
		} catch {}
		if (Date.now() - existing < LOCK_TTL_MS) return "busy";
		// stale: take over unconditionally
		await s.put(LOCK_KEY, JSON.stringify({ takenAt }));
		return { takenAt };
	}
};

const releaseLock = async (env: Env): Promise<void> => {
	await getStore(env).deleteKey(LOCK_KEY);
};

const runTickFor = (env: Env): Promise<TickResult> => {
	const fid = archiverFid(env);
	let lastPush = 0;
	return runTick(fid, getCtx(env), {
		hydrateBudget: Number(env.HYDRATE_BUDGET ?? 40),
		tickMs: Number(env.TICK_MS ?? 8 * 60_000) || 8 * 60_000,
		onProgress: (progress) => {
			const now = Date.now();
			// terminal events (running:false) bypass the throttle — dropping
			// one would leave the status object stuck mid-run forever
			if (progress.running && now - lastPush < 2_000) return;
			lastPush = now;
			void writeRunStatus(getStore(env), progress).catch(() => {});
		},
	});
};

const handleRun = async (env: Env): Promise<Response> => {
	const lock = await acquireLock(env);
	if (lock === "busy") {
		return Response.json({ queued: false, reason: "busy" }, { status: 409 });
	}
	try {
		const result = await runTickFor(env);
		return Response.json({ queued: true, result });
	} catch (error) {
		console.error("tick error:", error);
		return Response.json(
			{
				queued: true,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	} finally {
		await releaseLock(env);
	}
};

const handleStatus = async (env: Env): Promise<Response> => {
	const s = getStore(env);
	let progress: unknown;
	try {
		const obj = await s.get(runStatusKey);
		if (obj) progress = JSON.parse(new TextDecoder().decode(obj.body));
	} catch {}

	const obj = await s.get(LOCK_KEY);
	let running = false;
	let takenAt: number | undefined;
	if (obj) {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(obj.body)) as {
				takenAt?: number;
			};
			takenAt = parsed.takenAt;
			running = takenAt !== undefined && Date.now() - takenAt < LOCK_TTL_MS;
		} catch {}
	}
	// The tick persists its rotation-sweep cursor as a settings row
	// (tick_cursor:<fid> via ctx.data.setSetting) — not a meta/cursor object.
	const stored = await getJSON<{ value: string }>(
		s,
		settingKey(tickCursorKey(archiverFid(env))),
	);
	const parsedCursor = Number(stored?.value);
	const cursorOffset = Number.isFinite(parsedCursor) ? parsedCursor : undefined;
	return Response.json({ running, takenAt, cursorOffset, progress });
};

interface ScheduledEvent {
	cron: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/runs") {
			return handleRun(env);
		}
		// Inverted lockfile (MIGRATION.md §10.7): a tiny marker the server
		// poller watches — one PUT is well inside the free-plan CPU budget.
		if (request.method === "POST" && url.pathname === "/runs/request") {
			await getStore(env).put(
				runRequestKey,
				JSON.stringify({ requestedAt: Date.now() }),
			);
			return Response.json({ requested: true });
		}
		if (request.method === "GET" && url.pathname === "/runs/status") {
			return handleStatus(env);
		}
		if (url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}
		return new Response("not found", { status: 404 });
	},

	async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
		const lock = await acquireLock(env);
		if (lock === "busy") {
			console.log("scheduled tick: previous run still active — skipping");
			return;
		}
		try {
			const result = await runTickFor(env);
			console.log(
				`scheduled tick: ${result.renders} renders, ${result.hydrated} hydrated, ${result.failures} failures`,
			);
		} finally {
			await releaseLock(env);
		}
	},
};
