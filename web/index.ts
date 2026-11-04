import { Hono } from "hono";
import { hash2filename, normalizeHash } from "../src/lib/helpers";
import { archiveStats, castByHash, policy, status } from "./api";
import {
	browseFileHtml,
	browsePreviewHtml,
	browseRootHtml,
	browseUserHtml,
	listUserFiles,
	listUsernames,
	notFoundHtml,
} from "./browse";
import { getIndex } from "./data";
import type { Env } from "./env";
import { archiverFid, gatedUsername, getStore } from "./env";
import { installFacilitatorFetch } from "./facilitator-fetch";
import { statsFromIndex } from "./page";
import { timelineHtml } from "./timeline";
import { getGate } from "./x402";

const app = new Hono<{ Bindings: Env }>();

const PREVIEW_LENGTH = 60;
const TIMELINE_LIMIT = 20;
const TIMELINE_PREVIEW_LENGTH = 80;

export { app };

const BOOTED_AT = Math.floor(Date.now() / 1000);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/uptime", (c) =>
	c.json({ uptime_seconds: Math.floor(Date.now() / 1000) - BOOTED_AT }),
);

app.get("/timeline", async (c) => {
	try {
		const index = await getIndex(c.env);
		const spamaway = c.req.query("spamaway") !== "0";
		const textfiltersObj = await getStore(c.env).get(
			"config/textfilters.jsonl",
		);
		const textfilters: string[] = [];
		if (textfiltersObj) {
			for (const line of new TextDecoder()
				.decode(textfiltersObj.body)
				.split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				try {
					const parsed: unknown = JSON.parse(t);
					if (typeof parsed === "string" && parsed.trim()) {
						textfilters.push(parsed.trim());
					}
				} catch {
					// skip malformed filter lines
				}
			}
		}
		return timelineHtml(index, {
			limit: TIMELINE_LIMIT,
			previewLength: TIMELINE_PREVIEW_LENGTH,
			spamaway,
			textfilters,
		});
	} catch (error) {
		console.error("timeline error:", error);
		return c.text("timeline unavailable", 503);
	}
});

app.get("/api/cast/:hash", (c) => castByHash(c.env, c.req.param("hash")));

app.get("/status", (c) => status(c.env, c.req.query("fid")));

app.get("/api/archive/stats", async (c) => {
	try {
		return c.json(await archiveStats(c.env));
	} catch (error) {
		console.error("stats error:", error);
		return c.json({ error: "stats unavailable" }, 503);
	}
});

app.get("/api/policy", async (c) => {
	try {
		const p = await policy(c.env);
		return c.json({ min_age_days: p.minAgeDays, source: p.source });
	} catch {
		return c.json({ min_age_days: 7, source: "default" });
	}
});

/** POST /doIt — proxy to the archiver worker via the ARCHIVER binding (R1).
 *  202 immediately; the tick runs in the background via waitUntil. */
app.post("/doIt", async (c) => {
	try {
		const upstream = c.env.ARCHIVER.fetch(
			new Request("https://archiver/runs", { method: "POST" }),
		);
		c.executionCtx.waitUntil(upstream);
		return c.json({ queued: true }, 202);
	} catch (error) {
		console.error("doIt proxy error:", error);
		return c.text("archiver worker unreachable", 502);
	}
});

/** GET /browse and /browse/ — user-directory listing with the glance. */
const browseRoot = (c: { env: Env }) =>
	getIndex(c.env).then(async (index) => {
		const store = getStore(c.env);
		const usernames = await listUsernames(store);
		const p = await policy(c.env);
		const stats = statsFromIndex(index, p, []);
		const tiles: { label: string; value: string }[] = [
			{ label: "archived", value: stats.archived.toLocaleString() },
			{ label: "purged", value: stats.purged.toLocaleString() },
			{
				label: "min-age policy",
				value: `${stats.min_age_days}d (${stats.policy_source})`,
			},
			{ label: "users", value: stats.users.toLocaleString() },
		];
		const totalFiles = Object.values(index.rendered).reduce(
			(sum, files) => sum + Object.keys(files).length,
			0,
		);
		return browseRootHtml(usernames, tiles, stats.casts_per_month, totalFiles);
	});

app.get("/browse", (c) => browseRoot(c));
app.get("/browse/", (c) => browseRoot(c));

/** GET /browse/<user>/ — the user's rendered files, newest first. */
app.get("/browse/:username/", async (c) => {
	const username = c.req.param("username");
	const files = await listUserFiles(getStore(c.env), username);
	if (files.length === 0) return notFoundHtml();
	return browseUserHtml(username, files);
});

/** GET /browse/<user>/<file> — full page, or preview when paywalled. */
app.get("/browse/:username/:filename", async (c) => {
	const env = c.env;
	const username = decodeURIComponent(c.req.param("username"));
	const filename = decodeURIComponent(c.req.param("filename"));
	if (!filename.endsWith(".md")) return notFoundHtml();

	const store = getStore(env);
	const obj = await store.get(`out/${username}/${filename}`);
	if (!obj) return notFoundHtml();
	const markdown = new TextDecoder().decode(obj.body);

	const gate = await getGate(env);
	const gatedUser = gate?.username ?? gatedUsername(env);
	const isGated = gate !== undefined && username === gatedUser;
	const wantsPay = c.req.query("pay") === "1";
	const paymentHeader =
		c.req.header("payment-signature") ??
		c.req.header("x-payment") ??
		c.req.header("x-payment-signature");

	// allowlist fast path: verify the payer and serve free
	if (gate && paymentHeader && gate.allowlist.size > 0) {
		const payer = await gate.verifyPayer(c);
		if (payer && gate.allowlist.has(payer.toLowerCase())) {
			return browseFileHtml(markdown, username, filename);
		}
	}

	if (isGated && (wantsPay || paymentHeader)) {
		if (paymentHeader && !env.X402_API_KEY) {
			console.error(
				"[x402] payment present but X402_API_KEY unset — facilitator verify will 401",
			);
		}
		if (gate) {
			const gateResult = await gate.gate(c, () =>
				browseFileHtml(markdown, username, filename),
			);
			if (gateResult instanceof Response) return gateResult;
		}
		return notFoundHtml();
	}

	if (isGated) {
		return browsePreviewHtml(markdown, username, filename, PREVIEW_LENGTH);
	}
	return browseFileHtml(markdown, username, filename);
});

// informational: resolve a cast hash to its rendered filename
app.get("/api/hash/:hash/filename", async (c) => {
	const index = await getIndex(c.env);
	const hash = normalizeHash(c.req.param("hash"));
	const entry = index.casts[hash];
	if (!entry) return notFoundHtml();
	const username = index.users[String(entry[0])]?.username ?? `fid:${entry[0]}`;
	return c.json({
		username,
		filename: hash2filename(hash, new Date(entry[1])),
		fid: archiverFid(c.env),
	});
});

app.notFound(() => notFoundHtml());

app.onError((error, c) => {
	console.error(`web error on ${c.req.path}:`, error);
	return c.text("internal error", 500);
});

export default {
	fetch: (request: Request, env: Env): Response | Promise<Response> => {
		installFacilitatorFetch(env);
		return app.fetch(request, env);
	},
};
