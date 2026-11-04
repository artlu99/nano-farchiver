import { Hono } from "hono";
import { hash2filename, normalizeHash } from "../src/lib/helpers";
import { runStatusKey } from "../src/store/indexModel";
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
import { getIndex, getTextfilters } from "./data";
import type { Env } from "./env";
import { archiverFid, gatedUsername, getStore } from "./env";
import { installFacilitatorFetch } from "./facilitator-fetch";
import { statsFromIndex } from "./page";
import { spamThresholdFromQuery } from "./spam-threshold";
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
		const textfilters = await getTextfilters(getStore(c.env));
		return timelineHtml(index, {
			limit: TIMELINE_LIMIT,
			previewLength: TIMELINE_PREVIEW_LENGTH,
			spamaway,
			textfilters,
			spamThreshold: spamThresholdFromQuery(c.req.query("spam")),
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

/** POST /doIt — forwards to the archiver worker via the ARCHIVER binding,
 *  which writes the run-request marker; the server's minute poller consumes
 *  it and executes. 202 immediately (marker write is one tiny PUT). */
app.post("/doIt", async (c) => {
	try {
		const upstream = await c.env.ARCHIVER.fetch(
			new Request("https://archiver/runs/request", { method: "POST" }),
		);
		return c.json(await upstream.json(), 202);
	} catch (error) {
		console.error("doIt proxy error:", error);
		return c.text("archiver worker unreachable", 502);
	}
});

/** GET /runs/status — the run progress object written by the archiver. */
app.get("/runs/status", async (c) => {
	try {
		const obj = await getStore(c.env).get(runStatusKey);
		if (!obj) return c.json({ running: false, phase: "idle" });
		return c.json(JSON.parse(new TextDecoder().decode(obj.body)));
	} catch {
		return c.json({ running: false, phase: "idle" });
	}
});

/** GET /runs — live view: status badge, key counters, last line; polls 2 s. */
app.get("/runs", (c) =>
	c.html(
		`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>run status — nano-farchiver</title>
<link rel="stylesheet" href="/static/styles.css">
<style>
body{max-width:36rem;margin:2rem auto;font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
.breadcrumb{margin-bottom:1.5rem;font-size:.9rem;color:var(--muted)}
.breadcrumb a{color:var(--muted)}
.meta{font-size:.85rem;color:var(--muted)}
.phase{font-size:1.3rem;font-weight:700;margin:0}
.stats{display:flex;gap:.75rem;margin:1.25rem 0}
.stat{flex:1;background:var(--surface);border-radius:6px;padding:.9rem .5rem;text-align:center}
.stat .v{font-family:ui-monospace,monospace;font-size:1.7rem;font-weight:700;line-height:1.2}
.stat .l{font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.stat.bad .v{color:#b3174b}
.lastline{font-family:ui-monospace,monospace;font-size:.85rem;color:var(--muted);background:var(--surface);border-radius:6px;padding:.75rem 1rem;white-space:pre-wrap;word-break:break-word;min-height:1.4em}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.8rem;font-weight:600;vertical-align:.15em}
.badge.running{background:#e3f6ee;color:#00704f}
.badge.idle{background:var(--code-bg);color:var(--muted)}
.badge.error{background:#fde8ef;color:#b3174b}
</style>
</head>
<body>
<h1>Archiver run</h1>
<p><span id="badge" class="badge idle">idle</span> <span id="phase" class="phase">—</span></p>
<div class="stats">
<div class="stat"><div class="v" id="hydrated">—</div><div class="l">hydrated</div></div>
<div class="stat"><div class="v" id="renders">—</div><div class="l">renders</div></div>
<div class="stat" id="statFailures"><div class="v" id="failures">—</div><div class="l">failures</div></div>
</div>
<p class="meta">started <span id="started">—</span> · updated <span id="updated">—</span></p>
<p class="lastline" id="lastline"></p>
<p><a href="/">← back</a> · <a href="/timeline">timeline</a></p>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return new Date(t).toLocaleString();
};
function render(p) {
  const STALE_MS = 10 * 60 * 1000; // tick budget is 8 min — older = writer died
  const stale = p.running === true && (!p.updatedAt || Date.now() - p.updatedAt > STALE_MS);
  const running = p.running === true && !stale;
  const badge = $("badge");
  badge.textContent = running ? "running" : stale ? "stale" : (p.phase === "idle" ? "idle" : "finished");
  badge.className = "badge " + (running ? "running" : stale ? "error" : "idle");
  $("phase").textContent = esc(p.phase ?? "—");
  $("started").textContent = p.startedAt ? ago(p.startedAt) : "—";
  $("updated").textContent = p.updatedAt ? ago(p.updatedAt) : "—";
  $("started").title = p.startedAt ? new Date(p.startedAt).toLocaleString() : "";
  $("updated").title = p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "";
  $("hydrated").textContent = String(p.hydrated ?? "—");
  $("renders").textContent = String(p.renders ?? "—");
  const f = p.failures ?? 0;
  $("failures").textContent = String(f);
  $("statFailures").className = "stat" + (f > 0 ? " bad" : "");
  $("lastline").textContent = p.lastLine ?? "";
}
async function poll() {
  try {
    const res = await fetch("/runs/status", { cache: "no-store" });
    if (res.ok) render(await res.json());
  } catch {}
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>`,
		200,
		{ "Cache-Control": "no-store" },
	),
);

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
