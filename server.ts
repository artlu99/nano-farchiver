import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
import {
	FacilitatorResponseError,
	SettleError,
	VerifyError,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { PaywallConfig } from "@x402/hono";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { createPaywall, evmPaywall } from "@x402/paywall";
import { Hono } from "hono";
import { getAddress } from "viem";
import { doIt } from "./src/index";
import { serveBrowse, serveBrowseFile, servePreview } from "./src/lib/serve";
import { withTimeout } from "./src/lib/timeouts";

/**
 * Bun keeps `Request.url` as `http://...` when TLS terminates at Cloudflare / a tunnel,
 * but the browser page is `https://...`. The x402 paywall then does
 * `fetch(window.x402.currentUrl, { headers: { "PAYMENT-SIGNATURE": ... } })`; if that
 * URL is `http://` from the server, Safari blocks it as mixed content ("Load failed").
 *
 * Set `PUBLIC_APP_URL` if the tunnel host differs from what Bun sees.
 *  Otherwise we trust `x-forwarded-proto` / `x-forwarded-host`.
 */
function rewriteRequestUrlForPublicClient(request: Request): Request {
	const publicBase = process.env.PUBLIC_APP_URL?.replace(/\/+$/, "");
	try {
		const incoming = new URL(request.url);
		if (publicBase) {
			const fixed = new URL(
				incoming.pathname + incoming.search,
				`${publicBase}/`,
			);
			return new Request(fixed.href, request);
		}
		const forwardedProto = request.headers
			.get("x-forwarded-proto")
			?.split(",")[0]
			?.trim()
			.toLowerCase();
		if (forwardedProto === "https" && incoming.protocol === "http:") {
			incoming.protocol = "https:";
			const forwardedHost = request.headers
				.get("x-forwarded-host")
				?.split(",")[0]
				?.trim();
			const host = forwardedHost || request.headers.get("host");
			if (host) incoming.host = host;
			return new Request(incoming.href, request);
		}
	} catch {
		return request;
	}
	return request;
}

const startedAt = Date.now();

const LOCK_PATH = "db/doIt.lock";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JOB_TIMEOUT_MS = LOCK_TTL_MS - 5000; // slightly less than TTL
const DEFAULT_FID = 3319217;
const DEFAULT_USERNAME = "decent-artlu";
const X402_FACILITATOR_URL = "https://facilitator.artlu.xyz" as const;
/** Must match the facilitator’s configured bearer token or `/verify` and `/settle` return 401. */
const X402_API_KEY = process.env.X402_API_KEY;
if (!X402_API_KEY) {
	console.warn(
		`[nano-farchiver] X402_API_KEY is not set. Facilitator calls to ${X402_FACILITATOR_URL} (/verify, /settle, /supported) will get 401 if that service requires auth.`,
	);
}
const PAY_TO_ADDRESS = "0xAa591218305E621D8A128309e655A91e49A87a92";
const X402_BROWSE_PRICE = "$0.01" as const;
const X402_BROWSE_NETWORK = "eip155:8453" as const; // Base mainnet
const X402_BROWSE_DESCRIPTION = "Read archived cast" as const;

/**
 * Optional: `X402_MAX_TIMEOUT_SECONDS` — forwarded validity from "now" at sign time (still subject to +600
 * on the signed window as above). Parsed as a positive integer; invalid values fall back to default.
 */
const X402_BROWSE_MAX_TIMEOUT_DEFAULT_SECONDS = 15 * 60; // 900s forward skew from @x402/evm

function browseMaxTimeoutSecondsFromEnv(): number {
	const raw = process.env.X402_MAX_TIMEOUT_SECONDS;
	if (raw === undefined || raw === "") {
		return X402_BROWSE_MAX_TIMEOUT_DEFAULT_SECONDS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.warn(
			`[nano-farchiver] Invalid X402_MAX_TIMEOUT_SECONDS=${JSON.stringify(raw)}; using default ${X402_BROWSE_MAX_TIMEOUT_DEFAULT_SECONDS}`,
		);
		return X402_BROWSE_MAX_TIMEOUT_DEFAULT_SECONDS;
	}
	return parsed;
}

const X402_BROWSE_MAX_TIMEOUT_SECONDS = browseMaxTimeoutSecondsFromEnv();
const X402_ALLOWLIST =
	process.env.X402_ALLOWLIST?.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((addr) => getAddress(addr as `0x${string}`)) ?? [];
const x402Allowlist = new Set(X402_ALLOWLIST);

/** JSON for logs (BigInt-safe); avoids throwing on circular structures. */
function jsonForLog(value: unknown): string {
	try {
		return JSON.stringify(
			value,
			(_k, v) => (typeof v === "bigint" ? v.toString() : v),
			2,
		);
	} catch {
		return String(value);
	}
}

const facilitatorClient = new HTTPFacilitatorClient({
	url: X402_FACILITATOR_URL,
	createAuthHeaders: async () => {
		const auth = X402_API_KEY
			? { Authorization: `Bearer ${X402_API_KEY}` }
			: ({} as Record<string, string>);
		return {
			supported: { ...auth },
			verify: { ...auth },
			settle: { ...auth },
		};
	},
});
const x402Server = new x402ResourceServer(facilitatorClient)
	.register(X402_BROWSE_NETWORK, new ExactEvmScheme())
	.onVerifyFailure(async (ctx) => {
		console.error(
			"[x402] verify failed:",
			ctx.error instanceof Error ? ctx.error.message : ctx.error,
		);
	})
	.onBeforeSettle(async (ctx) => {
		console.log("[x402] settle begin (calling facilitator POST /settle)", {
			paymentPayload: jsonForLog(ctx.paymentPayload),
			requirements: jsonForLog(ctx.requirements),
		});
	})
	.onAfterSettle(async (ctx) => {
		const r = ctx.result;
		const tc = ctx.transportContext as
			| {
					responseBody?: Buffer | string;
					responseHeaders?: Record<string, string>;
			  }
			| undefined;
		let responseBodyBytes: number | undefined;
		if (tc?.responseBody !== undefined) {
			responseBodyBytes = Buffer.isBuffer(tc.responseBody)
				? tc.responseBody.length
				: typeof tc.responseBody === "string"
					? Buffer.byteLength(tc.responseBody)
					: undefined;
		}
		console.log("[x402] settle done (facilitator returned parsed body)", {
			success: r.success,
			fullResult: jsonForLog(r),
			paymentPayload: jsonForLog(ctx.paymentPayload),
			requirements: jsonForLog(ctx.requirements),
			transportContextKeys: tc && typeof tc === "object" ? Object.keys(tc) : [],
			responseBodyBytes,
		});
	})
	.onSettleFailure(async (ctx) => {
		const err = ctx.error;
		const errorDetails =
			err instanceof SettleError
				? {
						name: err.name,
						message: err.message,
						statusCode: err.statusCode,
						errorReason: err.errorReason,
						errorMessage: err.errorMessage,
						payer: err.payer,
						transaction: err.transaction,
						network: err.network,
					}
				: err instanceof FacilitatorResponseError
					? { name: err.name, message: err.message }
					: err instanceof Error
						? { name: err.name, message: err.message, stack: err.stack }
						: { thrown: String(err) };
		console.error("[x402] settle failure (exception or pre-parse)", {
			error: errorDetails,
			paymentPayload: jsonForLog(ctx.paymentPayload),
			requirements: jsonForLog(ctx.requirements),
		});
	});

const x402Routes = {
	[`GET /browse/${DEFAULT_USERNAME}/*`]: {
		accepts: {
			scheme: "exact",
			price: X402_BROWSE_PRICE,
			network: X402_BROWSE_NETWORK,
			payTo: PAY_TO_ADDRESS,
			maxTimeoutSeconds: X402_BROWSE_MAX_TIMEOUT_SECONDS,
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

function sha1Hex(input: string): string {
	return createHash("sha1").update(input).digest("hex");
}

const STATIC_DIR = resolve("static");

app.get(
	"/",
	() =>
		new Response(Bun.file(resolve(STATIC_DIR, "index.html")), {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "public, max-age=300",
			},
		}),
);

app.get("/static/*", (c) => {
	const relativePath = decodeURIComponent(
		c.req.path.slice("/static/".length),
	).replace(/^\/+/, "");
	const resolved = resolve(join(STATIC_DIR, relativePath));
	if (!resolved.startsWith(STATIC_DIR + sep) && resolved !== STATIC_DIR) {
		return c.notFound();
	}
	try {
		if (!statSync(resolved).isFile()) return c.notFound();
	} catch {
		return c.notFound();
	}
	return new Response(Bun.file(resolved), {
		headers: { "Cache-Control": "public, max-age=300" },
	});
});

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
		const payload = { outstanding: total - completed, completed };
		const body = JSON.stringify(payload);
		const etag = `W/"${sha1Hex(body)}"`;
		if (c.req.header("if-none-match") === etag) {
			return new Response(null, {
				status: 304,
				headers: {
					ETag: etag,
					"Cache-Control": "private, max-age=0, must-revalidate",
				},
			});
		}
		return new Response(body, {
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				ETag: etag,
				"Cache-Control": "private, max-age=0, must-revalidate",
			},
		});
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

	const payload = {
		fid: numFid,
		username: row?.username,
		outstanding: total - completed,
		completed,
	};
	const body = JSON.stringify(payload);
	const etag = `W/"${sha1Hex(body)}"`;
	if (c.req.header("if-none-match") === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				ETag: etag,
				"Cache-Control": "private, max-age=0, must-revalidate",
			},
		});
	}
	return new Response(body, {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			ETag: etag,
			"Cache-Control": "private, max-age=0, must-revalidate",
		},
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
		c.req.header("payment-signature") ??
		c.req.header("PAYMENT-SIGNATURE") ??
		c.req.header("Payment-Signature") ??
		c.req.header("x-payment") ??
		c.req.header("X-Payment") ??
		c.req.header("x-payment-signature") ??
		c.req.header("X-Payment-Signature");
	if (!paymentSignature) {
		return undefined;
	}

	let paymentPayload: ReturnType<typeof decodePaymentSignatureHeader>;
	try {
		paymentPayload = decodePaymentSignatureHeader(paymentSignature);
	} catch {
		console.warn("[x402] allowlist path: payment signature decode failed");
		return undefined;
	}

	const requirements = await x402Server.buildPaymentRequirementsFromOptions(
		[
			{
				scheme: "exact",
				price: X402_BROWSE_PRICE,
				network: X402_BROWSE_NETWORK,
				payTo: PAY_TO_ADDRESS,
				maxTimeoutSeconds: X402_BROWSE_MAX_TIMEOUT_SECONDS,
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
	} catch (err) {
		if (err instanceof VerifyError) {
			console.error("x402 verifyPayment (facilitator) rejected:", {
				invalidReason: err.invalidReason,
				invalidMessage: err.invalidMessage,
				payer: err.payer,
				statusCode: err.statusCode,
			});
		} else {
			console.error("x402 verifyPayment threw:", err);
		}
		return undefined;
	}
}

app.get("/browse/*", async (c) => {
	if (isFileRequest(c.req.path)) {
		const relativePath = decodeURIComponent(
			c.req.path.slice("/browse/".length),
		).replace(/\/+$/, "");
		const isDefaultUserFile =
			relativePath === DEFAULT_USERNAME ||
			relativePath.startsWith(`${DEFAULT_USERNAME}/`);

		// Free for everyone else: serve full content, no preview.
		if (!isDefaultUserFile) {
			return serveBrowseFile(c.req.path);
		}

		const wantsPay = c.req.query("pay") === "1";
		const paymentHeader =
			c.req.header("payment-signature") ??
			c.req.header("PAYMENT-SIGNATURE") ??
			c.req.header("Payment-Signature") ??
			c.req.header("x-payment") ??
			c.req.header("X-Payment") ??
			c.req.header("x-payment-signature") ??
			c.req.header("X-Payment-Signature");

		// Important: the x402 paywall UI may "pay" via a fetch() retry that includes
		// an x402 header (commonly `x-payment`) but may NOT preserve your `?pay=1`
		// query param. So we treat "has x402 header" as an intent to pay too.
		if (wantsPay || paymentHeader) {
			if (paymentHeader && !X402_API_KEY) {
				console.error(
					"[nano-farchiver] PAYMENT-SIGNATURE present but X402_API_KEY is unset — facilitator POST /verify will return 401. Export it in the shell or add it to .env in the cwd where you start Bun.",
				);
			}
			// Allowlist-only fast path: avoid calling the facilitator twice (here + x402Gate).
			let payer: string | undefined;
			if (x402Allowlist.size > 0 && paymentHeader) {
				payer = await verifyX402AndGetPayer(c);
				if (payer && x402Allowlist.has(payer as `0x${string}`)) {
					return serveBrowseFile(c.req.path);
				}
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
app.get("/browse", (c) => serveBrowse(c.req.path, DEFAULT_USERNAME));

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
		new Response(Bun.file(resolve(STATIC_DIR, "llms.txt")), {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=300",
			},
		}),
);

const fetchWithPublicUrl: typeof app.fetch = (req, env, executionCtx) =>
	app.fetch(rewriteRequestUrlForPublicClient(req), env, executionCtx);

export default { fetch: fetchWithPublicUrl };
