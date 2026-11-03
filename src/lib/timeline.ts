import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { escapeHtml, hash2filename, normalizeHash, utcDayKey } from "./helpers";

const TEXTFILTERS_PATH = "db/textfilters.jsonl";

function renderPage(title: string, bodyHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — nano-farchiver</title>
<link rel="stylesheet" href="/static/styles.css">
<style>
body{max-width:48rem;margin:2rem auto}
.breadcrumb{margin-bottom:1.5rem;font-size:.9rem;color:var(--muted)}
.breadcrumb a{color:var(--muted)}.breadcrumb a:hover{color:var(--link)}
.timeline-controls{display:flex;align-items:center;gap:.75rem;margin:.75rem 0 1.25rem}
.timeline-toggle{display:inline-flex;align-items:center;gap:.5rem;font-size:.9rem;color:var(--fg);user-select:none}
.timeline-toggle input{width:1rem;height:1rem}
h2.day{margin:2rem 0 .75rem;padding-top:1rem;border-top:1px solid var(--border);font-size:1.15rem;color:var(--fg)}
h2.day:first-of-type{border-top:none;padding-top:0;margin-top:0}
.cast-row{margin:.75rem 0;padding:.5rem 0;border-bottom:1px solid var(--border)}
.cast-meta{font-size:.85rem;color:var(--muted);margin-bottom:.25rem}
.cast-snippet{color:var(--fg);font-size:.95rem}
.reply-hint{margin:.35rem 0 0;font-size:.85rem;color:var(--muted);padding-left:.75rem;border-left:2px solid var(--border)}
.reply-hint a{color:var(--muted)}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

type CastRow = {
	hash: string;
	fid: number;
	data: string;
	parent_hash: string | null;
	username: string | null;
};

type ParentInfo = {
	username: string;
	basename: string;
	snippet: string;
};

function browseHref(username: string, basename: string): string {
	const encUser = encodeURIComponent(username);
	const encFile = encodeURIComponent(basename);
	return posix.join("/browse", encUser, encFile);
}

function snippetFromCast(cast: Cast, maxLen: number): string {
	const t = (cast.text ?? "").replace(/\s+/g, " ").trim();
	if (t.length <= maxLen) return t;
	return `${t.slice(0, maxLen)}…`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadTextFilters(): string[] {
	try {
		if (!existsSync(TEXTFILTERS_PATH)) return [];
		const raw = readFileSync(TEXTFILTERS_PATH, "utf8");
		const out: string[] = [];
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(t);
			} catch {
				continue;
			}
			if (typeof parsed === "string" && parsed.trim()) {
				out.push(parsed.trim());
			}
		}
		return out;
	} catch {
		return [];
	}
}

function makeWholeWordRegex(words: string[]): RegExp | null {
	const cleaned = words.map((w) => w.trim()).filter(Boolean);
	if (cleaned.length === 0) return null;
	const alt = cleaned.map(escapeRegExp).join("|");
	// Whole-word match; case-insensitive. This intentionally treats "gm!" as a match.
	return new RegExp(String.raw`\b(?:${alt})\b`, "i");
}

/** HTML global timeline (UTC days, newest first). */
export function serveTimeline(
	timeline_limit: number,
	preview_length: number,
): Response;
export function serveTimeline(
	timeline_limit: number,
	preview_length: number,
	spamaway: boolean,
): Response;
export function serveTimeline(
	timeline_limit: number,
	preview_length: number,
	spamaway: boolean = true,
): Response {
	const timeline_prefetch = timeline_limit * 2;

	if (!existsSync("db/queue.db3")) {
		return new Response("database not found — run the archiver first", {
			status: 503,
		});
	}

	const db = new Database("db/queue.db3", { readonly: true });

	try {
		const deletedRows = db.query("SELECT hash FROM deleted_casts").all() as {
			hash: string;
		}[];
		const deleted = new Set(deletedRows.map((r) => normalizeHash(r.hash)));

		const rows = db
			.query(
				`SELECT c.hash, c.fid, c.data, c.parent_hash, u.username
FROM casts c
LEFT JOIN users u ON u.fid = c.fid
ORDER BY json_extract(c.data, '$.timestamp') DESC
LIMIT ${timeline_prefetch}`,
			)
			.all() as CastRow[];

		let visible = rows.filter((r) => !deleted.has(normalizeHash(r.hash)));

		// spamaway: filter out casts containing spam whole-words from textfilters.
		if (spamaway) {
			const filters = loadTextFilters();
			const rx = makeWholeWordRegex(filters);
			if (rx) {
				visible = visible.filter((r) => {
					try {
						const cast = JSON.parse(r.data) as Cast;
						const text = (cast.text ?? "").toString();
						return !rx.test(text);
					} catch {
						// If it doesn't parse, keep it (avoid accidentally hiding data).
						return true;
					}
				});
			}
		}

		visible = visible.slice(0, timeline_limit);

		const parentHashes = new Set<string>();
		for (const r of visible) {
			if (!r.parent_hash) continue;
			const ph = normalizeHash(r.parent_hash);
			if (!deleted.has(ph)) parentHashes.add(ph);
		}

		const parentMap = new Map<string, ParentInfo>();
		if (parentHashes.size > 0) {
			const list = [...parentHashes];
			const placeholders = list.map(() => "?").join(", ");
			const parents = db
				.query(
					`SELECT c.hash, c.data, u.username
FROM casts c
LEFT JOIN users u ON u.fid = c.fid
WHERE c.hash IN (${placeholders})`,
				)
				.all(...list) as {
				hash: string;
				data: string;
				username: string | null;
			}[];

			for (const p of parents) {
				if (deleted.has(normalizeHash(p.hash))) continue;
				let cast: Cast;
				try {
					cast = JSON.parse(p.data) as Cast;
				} catch {
					continue;
				}
				const username =
					p.username?.trim() ||
					cast.author?.username?.trim() ||
					`fid:${cast.author?.fid ?? "?"}`;
				parentMap.set(normalizeHash(p.hash), {
					username,
					basename: hash2filename(p.hash, cast.timestamp),
					snippet: snippetFromCast(cast, preview_length),
				});
			}
		}

		const days = new Map<string, CastRow[]>();
		for (const r of visible) {
			let cast: Cast;
			try {
				cast = JSON.parse(r.data) as Cast;
			} catch {
				continue;
			}
			const day = utcDayKey(cast.timestamp);
			let arr = days.get(day);
			if (!arr) {
				arr = [];
				days.set(day, arr);
			}
			arr.push(r);
		}

		const sortedDays = [...days.keys()].sort().reverse();

		let body = `<div class="breadcrumb"><a href="/browse">out</a> / <span>timeline</span></div>`;
		body += `<h1>Timeline</h1>`;
		body += `<div class="timeline-controls">`;
		body += `<label class="timeline-toggle"><input type="checkbox" id="spamaway-toggle"> <span>spamaway</span></label>`;
		body += `</div>`;
		body += `<p>Showing ${visible.length} latest casts</p>`;

		for (const day of sortedDays) {
			const dayRows = days.get(day);
			if (!dayRows) continue;
			body += `<h2 class="day" id="${escapeHtml(day)}">${escapeHtml(day)}</h2>`;

			for (const r of dayRows) {
				let cast: Cast;
				try {
					cast = JSON.parse(r.data) as Cast;
				} catch {
					continue;
				}
				const username =
					r.username?.trim() || cast.author?.username?.trim() || `fid:${r.fid}`;
				const basename = hash2filename(r.hash, cast.timestamp);
				const href = browseHref(username, basename);
				const textSnip = escapeHtml(snippetFromCast(cast, preview_length));

				body += `<article class="cast-row">`;
				body += `<div class="cast-meta"><a href="${escapeHtml(href)}">@${escapeHtml(username)}</a> · <code><a href="https://forkcaster.xyz/${escapeHtml(username)}/${escapeHtml(normalizeHash(r.hash)).slice(0, 10)}" target="_blank" rel="noopener noreferrer">${escapeHtml(normalizeHash(r.hash).slice(0, 10))}</a></code></div>`;
				body += `<div class="cast-snippet">${textSnip}</div>`;

				if (r.parent_hash) {
					const ph = normalizeHash(r.parent_hash);
					const pinfo = parentMap.get(ph);
					if (pinfo && !deleted.has(ph)) {
						const phref = browseHref(pinfo.username, pinfo.basename);
						body += `<p class="reply-hint">↳ reply to <a href="${escapeHtml(phref)}">@${escapeHtml(pinfo.username)}</a> — ${escapeHtml(pinfo.snippet)}</p>`;
					} else {
						body += `<p class="reply-hint">↳ reply (parent unavailable)</p>`;
					}
				}

				body += `</article>`;
			}
		}

		body += `<script>
(() => {
  const KEY = "nano-farchiver:timeline:spamaway";
  const el = document.getElementById("spamaway-toggle");
  if (!el) return;

  const input = el;
  const url = new URL(location.href);
  const param = url.searchParams.get("spamaway");
  const hasParam = param !== null;

  function parseSpamawayParam(raw) {
    if (raw == null) return null;
    const v = String(raw).trim();
    if (v === "0") return false;
    if (v === "1") return true;
    return null;
  }

  // Omitted param defaults to enabled on the server; URL may omit ?spamaway=.
  let enabled = true;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "0") enabled = false;
    if (stored === "1") enabled = true;
  } catch {}

  const enabledFromParam = parseSpamawayParam(param);
  if (enabledFromParam !== null) enabled = enabledFromParam;
  input.checked = enabled;

  // Stored "off" but no param: server would treat as on — align URL with storage.
  if (!hasParam && enabled === false) {
    url.searchParams.set("spamaway", "0");
    location.replace(url.toString());
    return;
  }

  // Keep storage in sync with the actual server-driven state.
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {}

  const DEBOUNCE_MS = 150;
  let refreshTimer = 0;
  function debouncedRefresh(nextUrl) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // Reload from backend (server-rendered timeline HTML).
      location.href = nextUrl.toString();
    }, DEBOUNCE_MS);
  }

  input.addEventListener("change", () => {
    try {
      localStorage.setItem(KEY, input.checked ? "1" : "0");
    } catch {}
    const next = new URL(location.href);
    next.searchParams.set("spamaway", input.checked ? "1" : "0");
    debouncedRefresh(next);
  });
})();
</script>`;

		return new Response(renderPage("Timeline", body), {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "private, max-age=0, must-revalidate",
			},
		});
	} finally {
		db.close();
	}
}
