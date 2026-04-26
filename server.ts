import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { HTTPAdapter, HTTPRequestContext } from "@x402/core/server";
import {
	HTTPFacilitatorClient,
	x402HTTPResourceServer,
	x402ResourceServer,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { PaywallConfig } from "@x402/hono";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { createPaywall, evmPaywall } from "@x402/paywall";
import { Hono } from "hono";
import { getAddress } from "viem";
import { doIt } from "./src/index";
import { serveBrowse, serveBrowseFile, servePreview } from "./src/lib/serve";
import { withTimeout } from "./src/lib/timeouts";

const startedAt = Date.now();

const LOCK_PATH = "db/doIt.lock";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JOB_TIMEOUT_MS = LOCK_TTL_MS - 5000; // slightly less than TTL
const DEFAULT_FID = 3319217;
const DEFAULT_TITLE = "decent-artlu";
const X402_FACILITATOR_URL = "https://facilitator.xpay.sh" as const;
const PAY_TO_ADDRESS = "0x094f1608960A3cb06346cFd55B10b3cEc4f72c78";
const X402_BROWSE_PRICE = "$0.001" as const;
const X402_BROWSE_NETWORK = "eip155:8453" as const; // Base mainnet
const X402_BROWSE_DESCRIPTION = "Read archived cast" as const;
const X402_ALLOWLIST =
	process.env.X402_ALLOWLIST?.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((addr) => getAddress(addr as `0x${string}`)) ?? [];
const x402Allowlist = new Set(X402_ALLOWLIST);

const facilitatorClient = new HTTPFacilitatorClient({
	url: X402_FACILITATOR_URL,
});
const x402Server = new x402ResourceServer(facilitatorClient).register(
	X402_BROWSE_NETWORK,
	new ExactEvmScheme(),
);

const x402Routes = {
	"GET /browse/*": {
		accepts: {
			scheme: "exact",
			price: X402_BROWSE_PRICE,
			network: X402_BROWSE_NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description: X402_BROWSE_DESCRIPTION,
	},
} as const;

const x402HttpServer = new x402HTTPResourceServer(x402Server, x402Routes);

const x402PaywallConfig: PaywallConfig = {
	appName: "nano-farchiver",
	testnet: false,
};

const x402PaywallProvider = createPaywall().withNetwork(evmPaywall).build();

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

app.get(
	"/",
	() =>
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
		db.query("SELECT COUNT(*) as n FROM casts WHERE fid = ?").get(numFid) as {
			n: number;
		}
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

const x402Gate = paymentMiddlewareFromHTTPServer(
	x402HttpServer,
	x402PaywallConfig,
	x402PaywallProvider,
	true, // sync facilitator support on first protected request
);

async function verifyX402AndGetPayer(c: Parameters<typeof x402Gate>[0]) {
	const paymentSignature =
		c.req.header("payment-signature") ?? c.req.header("PAYMENT-SIGNATURE");
	if (!paymentSignature) return undefined;

	let paymentPayload: ReturnType<typeof decodePaymentSignatureHeader>;
	try {
		paymentPayload = decodePaymentSignatureHeader(paymentSignature);
	} catch {
		return undefined;
	}

	const requirements = await x402Server.buildPaymentRequirementsFromOptions(
		[
			{
				scheme: "exact",
				price: X402_BROWSE_PRICE,
				network: X402_BROWSE_NETWORK,
				payTo: PAY_TO_ADDRESS,
			},
		],
		((): HTTPRequestContext => {
			const adapter: HTTPAdapter = {
				getHeader: (name) => c.req.header(name),
				getMethod: () => c.req.method,
				getPath: () => c.req.path,
				getUrl: () => c.req.url,
				getAcceptHeader: () => c.req.header("accept") ?? "",
				getUserAgent: () => c.req.header("user-agent") ?? "",
				getQueryParams: () =>
					Object.fromEntries(new URL(c.req.url).searchParams.entries()),
				getQueryParam: (name) =>
					new URL(c.req.url).searchParams.get(name) ?? undefined,
				getBody: async () => undefined,
			};
			return { adapter, path: c.req.path, method: c.req.method };
		})(),
	);
	const matching = x402Server.findMatchingRequirements(
		requirements,
		paymentPayload,
	);
	if (!matching) {
		return undefined;
	}

	try {
		const verification = await x402Server.verifyPayment(
			paymentPayload,
			matching,
		);

		if (!verification.isValid) {
			return undefined;
		}
		const payer = verification.payer
			? getAddress(verification.payer as `0x${string}`)
			: undefined;
		return payer;
	} catch {
		return undefined;
	}
}

app.get("/browse/*", async (c) => {
	if (isFileRequest(c.req.path)) {
		if (c.req.query("pay") === "1") {
			const payer = await verifyX402AndGetPayer(c);
			if (payer && x402Allowlist.has(payer)) {
				return serveBrowseFile(c.req.path);
			}
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

app.get(
	"/llms.txt",
	() =>
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
