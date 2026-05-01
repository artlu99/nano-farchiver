import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Cast } from "@neynar/nodejs-sdk/build/api";
import { escapeHtml, hash2filename, normalizeHash, utcDayKey } from "./helpers";

function renderPage(title: string, bodyHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — nano-farchiver</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1a1a1a}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.breadcrumb{margin-bottom:1.5rem;font-size:.9rem;color:#888}
.breadcrumb a{color:#888}.breadcrumb a:hover{color:#2563eb}
h2.day{margin:2rem 0 .75rem;padding-top:1rem;border-top:1px solid #e5e7eb;font-size:1.15rem;color:#374151}
h2.day:first-of-type{border-top:none;padding-top:0;margin-top:0}
.cast-row{margin:.75rem 0;padding:.5rem 0;border-bottom:1px solid #f3f4f6}
.cast-meta{font-size:.85rem;color:#6b7280;margin-bottom:.25rem}
.cast-snippet{color:#1a1a1a;font-size:.95rem}
.reply-hint{margin:.35rem 0 0;font-size:.85rem;color:#6b7280;padding-left:.75rem;border-left:2px solid #e5e7eb}
.reply-hint a{color:#4b5563}
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

/** HTML global timeline (UTC days, newest first). */
export function serveTimeline(
	timeline_limit: number,
	preview_length: number,
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

		const visible = rows
			.filter((r) => !deleted.has(normalizeHash(r.hash)))
			.slice(0, timeline_limit);

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
		body += `<h1>Timeline</h1><p>Showing ${visible.length} latest casts</p>`;

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
				body += `<div class="cast-meta"><a href="${escapeHtml(href)}">@${escapeHtml(username)}</a> · <code><a href="https://farcaster.xyz/${escapeHtml(username)}/${escapeHtml(r.hash).slice(0, 10)}" target="_blank" rel="noopener noreferrer">${escapeHtml(normalizeHash(r.hash).slice(0, 10))}</a></code></div>`;
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
