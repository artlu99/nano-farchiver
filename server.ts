import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { doIt } from "./src/index";
import { serveBrowse, serveBrowseFile, servePreview } from "./src/lib/serve";
import { withTimeout } from "./src/lib/timeouts";

const startedAt = Date.now();

const LOCK_PATH = "db/doIt.lock";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JOB_TIMEOUT_MS = LOCK_TTL_MS - 5000; // slightly less than TTL
const DEFAULT_FID = 3319217;
const DEFAULT_TITLE = 'decent-artlu';
const PAY_TO_ADDRESS = "0x094f1608960A3cb06346cFd55B10b3cEc4f72c78";

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

const app = new Hono();

app.get("/", () =>
	new Response(
		`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nano-farchiver</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#1a1a1a}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>nano-farchiver</h1>
<p>Farcaster cast archive. Browse or check status below.</p>
<ul>
<li><a href="/browse">Browse archive</a></li>
<li><a href="/status">Job status</a></li>
<li><a href="/llms.txt">llms.txt</a></li>
</ul>
</body>
</html>`,
		{ headers: { "Content-Type": "text/html; charset=utf-8" } },
	),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/uptime", (c) =>
	c.json({ uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }),
);

app.get("/status", async (c) => {
	if (!existsSync("db/queue.db3")) {
		return c.json(
			{ error: "database not found — run the archiver first" },
			503,
		);
	}
	const db = new Database("db/queue.db3", { readonly: true });

	const fid = c.req.query("fid");
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
		return c.json({ outstanding: total - completed, completed });
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

	return c.json({
		fid: numFid,
		username: row?.username,
		outstanding: total - completed,
		completed,
	});
});

app.post("/doIt", async (c) => {
	if (!(await acquireLock())) {
		return c.text("Job already running", 429);
	}
	withTimeout(doIt(DEFAULT_FID), {
		timeoutMs: JOB_TIMEOUT_MS,
		timeoutMessage: "Job timed out",
	})
		.catch((err) => console.error(err))
		.finally(releaseLock);
	return c.text("Job started", 202);
});

app.post("/clear", async (c) => {
	await rm("db/cache.db3", { force: true });
	return c.text("Cache cleared", 200);
});

const x402Gate = paymentMiddleware(PAY_TO_ADDRESS, {
	"/browse/*": {
		price: "$0.001",
		network: "base",
		config: {
			description: "Read archived cast",
		},
	},
});

app.get("/browse/*", async (c) => {
	if (isFileRequest(c.req.path)) {
		if (c.req.query("pay") === "1") {
			let result: Response | undefined;
			const gateResult = await x402Gate(c, async () => {
				result = serveBrowseFile(c.req.path);
			});
			if (gateResult instanceof Response) return gateResult;
			return result ?? c.notFound();
		}
		return servePreview(c.req.path);
	}
	return serveBrowse(c.req.path);
});
app.get("/browse", (c) => serveBrowse(c.req.path, DEFAULT_TITLE));

const OUT_DIR = resolve("out");

function isFileRequest(pathname: string): boolean {
	const relativePath = decodeURIComponent(
		pathname.slice("/browse/".length),
	).replace(/\/+$/, "");
	const resolved = resolve(join(OUT_DIR, relativePath));
	if (!resolved.startsWith(OUT_DIR + sep) && resolved !== OUT_DIR) return false;
	try {
		return statSync(resolved).isFile();
	} catch {
		return false;
	}
}

app.get("/llms.txt", () =>
	new Response(
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

## /clear (POST)
Clears the network cache so the next /doIt fetches fresh data from the API. Use before /doIt for incremental updates.

## /browse
Browse the archived output directory. Lists users.

## /browse/**
Browse archived casts. Directory listings are free.
Cast files show a free preview with metadata and first 5 characters of text.
Add ?pay=1 to trigger x402 payment ($0.001 on Base) for the full file.
Markdown files are rendered as formatted HTML.
`,
		{ headers: { "Content-Type": "text/plain" } },
	),
);

export default app;
