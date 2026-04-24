import { existsSync, readdirSync } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { doIt } from "./src/index";
import { serveBrowse } from "./src/lib/serve";
import { withTimeout } from "./src/lib/timeouts";

const startedAt = Date.now();

const LOCK_PATH = "db/doIt.lock";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JOB_TIMEOUT_MS = LOCK_TTL_MS - 5000; // slightly less than TTL
const DEFAULT_FID = 3319217;

async function acquireLock(): Promise<boolean> {
	try {
		const lockStat = await stat(LOCK_PATH);
		const age = Date.now() - lockStat.mtimeMs;
		if (age > LOCK_TTL_MS) {
			await unlink(LOCK_PATH);
		} else {
			return false;
		}
	} catch {
		// no lock file — good
	}
	await writeFile(LOCK_PATH, process.pid.toString());
	return true;
}

async function releaseLock(): Promise<void> {
	await unlink(LOCK_PATH).catch(() => {});
}

async function handleDoIt(): Promise<Response> {
	if (!(await acquireLock())) {
		return new Response("Job already running", { status: 429 });
	}
	// Fire and forget — don't await the job
	withTimeout(doIt(DEFAULT_FID), {
		timeoutMs: JOB_TIMEOUT_MS,
		timeoutMessage: "Job timed out",
	})
		.catch((err) => console.error(err))
		.finally(releaseLock);
	return new Response("Job started", { status: 202 });
}

Bun.serve({
	port: process.env.PORT ?? 3000,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}

		if (url.pathname === "/uptime") {
			return Response.json({
				uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
			});
		}

		if (url.pathname === "/status" || url.pathname === "/status/") {
			if (!existsSync("db/queue.db3")) {
				return Response.json(
					{ error: "database not found — run the archiver first" },
					{ status: 503 },
				);
			}
			const db = new Database("db/queue.db3", { readonly: true });

			const fid = url.searchParams.get("fid");
			if (!fid) {
				const total = (
					db.query("SELECT COUNT(*) as n FROM casts").get() as { n: number }
				).n;
				let completed = 0;
				try {
					for (const user of db.query("SELECT username FROM users").all() as {
						username: string;
					}[]) {
						try {
							completed += readdirSync(`out/${user.username}`).filter((f) =>
								f.endsWith(".md"),
							).length;
						} catch {
							// directory doesn't exist yet → skip
						}
					}
				} catch {}
				return Response.json({ outstanding: total - completed, completed });
			}
			const numFid = Number(fid);

			const total = (
				db
					.query("SELECT COUNT(*) as n FROM casts WHERE fid = ?")
					.get(numFid) as { n: number }
			).n;

			const row = db
				.query("SELECT username FROM users WHERE fid = ?")
				.get(numFid) as { username: string } | undefined;

			let completed = 0;
			if (row) {
				try {
					const files = await readdir(`out/${row.username}`);
					completed = files.filter((f) => f.endsWith(".md")).length;
				} catch {
					// directory doesn't exist yet → 0 completed
				}
			}

			return Response.json({
				fid: numFid,
				username: row?.username,
				outstanding: total - completed,
				completed,
			});
		}

		if (url.pathname === "/doIt" && req.method === "POST") {
			return handleDoIt();
		}

		if (url.pathname === "/browse" || url.pathname.startsWith("/browse/")) {
			return serveBrowse(url.pathname);
		}

		if (url.pathname === "/llms.txt") {
			return new Response(
				`# nano-farchiver

## /health
Returns { "status": "ok" }.

## /uptime
Returns { "uptime_seconds": <int> } seconds since server started.

## /status?fid=<number>
Returns { "fid", "username", "outstanding", "completed" } for a single user.

## /status
Returns aggregate { "outstanding", "completed" } across all users.

## /doIt (POST)
Triggers the archiver job. Returns 202 if started, 429 if already running. Poll /status for progress.

## /browse/**
Browse the archived output directory. Lists directories and .md files.
Markdown files are rendered as formatted HTML.
`,
				{ headers: { "Content-Type": "text/plain" } },
			);
		}

		return new Response("not found", { status: 404 });
	},
});

console.log("Listening on http://localhost:3000");
