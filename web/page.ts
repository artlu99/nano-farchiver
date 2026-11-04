import { escapeHtml } from "../src/lib/helpers";
import type { ArchiveIndex } from "../src/store/indexModel";

/**
 * Shared HTML shell + small pure renderers for the read-only web piece.
 * Ported from src/lib/{serve,stats}.ts (which stay on the Bun stack — this
 * module is Workers-only and must not import anything bun:sqlite-backed).
 */

export interface PageOptions {
	title: string;
	bodyHtml: string;
	/** Timeline is parameter-dependent → no-store; other pages cache at the edge. */
	cacheControl?: string;
}

export const renderPage = ({
	title,
	bodyHtml,
	cacheControl = "public, max-age=300",
}: PageOptions): Response =>
	new Response(
		`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — nano-farchiver</title>
<link rel="stylesheet" href="/static/styles.css">
<style>
body{max-width:48rem;margin:2rem auto}
pre{background:var(--code-bg);padding:1rem;border-radius:4px;overflow-x:auto}
code{background:var(--code-bg);padding:.15rem .3rem;border-radius:3px;font-size:.9em}
img{max-width:100%}
dl{background:var(--surface);padding:1rem;border-radius:4px;margin-bottom:1.5rem}
dt{font-weight:600}dd{margin:0 0 .25rem 1rem;color:var(--muted)}
.breadcrumb{margin-bottom:1.5rem;font-size:.9rem;color:var(--muted)}
.breadcrumb a{color:var(--muted)}.breadcrumb a:hover{color:var(--link)}
ul.entries{list-style:none;padding:0}
ul.entries li{padding:.25rem 0}
.dir{font-weight:600}
.preview{background:var(--accent-bg);border-left:3px solid var(--accent-border);padding:1rem;margin-bottom:1.5rem;border-radius:0 4px 4px 0}
.preview-text{margin:0;font-size:1.1rem}
.pay-link{display:inline-block;margin-top:1rem;padding:.5rem 1rem;background:var(--btn-bg);color:var(--btn-fg);text-decoration:none;border-radius:4px}
.pay-link:hover{background:var(--btn-hover);text-decoration:none}
.glance{margin-bottom:1.5rem}
.stat-row{display:flex;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem}
.stat-tile{background:var(--surface);border-radius:4px;padding:.6rem 1rem;min-width:7rem}
.stat-value{font-weight:600;font-size:1.15rem}
.stat-label{color:var(--muted);font-size:.8rem}
.hist-row{display:flex;align-items:flex-end;gap:2px;height:5rem;background:var(--surface);padding:.75rem;border-radius:4px}
.hist-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;height:100%}
.hist-bar{width:100%;background:var(--accent-border);border-radius:1px 1px 0 0}
.hist-label{font-size:.55rem;color:var(--muted);margin-top:.25rem}
.cast-row{margin:.75rem 0;padding:.5rem 0;border-bottom:1px solid var(--border)}
.cast-meta{font-size:.85rem;color:var(--muted);margin-bottom:.25rem}
.cast-snippet{color:var(--fg);font-size:.95rem}
h2.day{margin:2rem 0 .75rem;padding-top:1rem;border-top:1px solid var(--border);font-size:1.15rem}
.timeline-controls{display:flex;align-items:center;gap:.75rem;margin:.75rem 0 1.25rem;flex-wrap:wrap}
.timeline-toggle{display:inline-flex;align-items:center;gap:.5rem;font-size:.9rem;color:var(--fg);user-select:none}
.timeline-toggle input{width:1rem;height:1rem}
.timeline-slider{display:inline-flex;align-items:center;gap:.5rem;font-size:.9rem;color:var(--fg)}
.timeline-slider input[type="range"]{width:9rem;touch-action:pan-y;-webkit-user-select:none;user-select:none}
.timeline-slider .value{min-width:2.2rem;text-align:right;font-variant-numeric:tabular-nums}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`,
		{
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				// public pages are identical for everyone — edge-cacheable (§4.2)
				"Cache-Control": cacheControl,
			},
		},
	);

export const breadcrumb = (parts: string[]): string => {
	let html =
		parts.length === 0
			? `<div class="breadcrumb"><a href="/">home</a>`
			: `<div class="breadcrumb"><a href="/browse">out</a>`;
	for (let i = 0; i < parts.length; i++) {
		const href = `/browse/${parts
			.slice(0, i + 1)
			.map(encodeURIComponent)
			.join("/")}`;
		html += ` / <a href="${href}">${escapeHtml(parts[i] ?? "")}</a>`;
	}
	return `${html}</div>`;
};

export interface StatTile {
	label: string;
	value: string;
}

export const statsHtml = (
	tiles: StatTile[],
	histogram: { month: string; count: number }[],
): string => {
	const maxCount = Math.max(1, ...histogram.map((h) => h.count));
	const tileHtml = tiles
		.map(
			({ label, value }) =>
				`<div class="stat-tile"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div>`,
		)
		.join("");
	const bars = histogram
		.map(
			({ month, count }) =>
				`<div class="hist-col" title="${escapeHtml(month)}: ${count}"><div class="hist-bar" style="height:${Math.max(2, Math.round((count / maxCount) * 100))}%"></div><div class="hist-label">${escapeHtml(month.slice(2))}</div></div>`,
		)
		.join("");
	return `<div class="glance">
  <div class="stat-row">${tileHtml}</div>
  ${histogram.length > 0 ? `<div class="hist-row">${bars}</div>` : ""}
</div>`;
};

export interface Frontmatter {
	frontmatter: Record<string, string>;
	body: string;
}

export const parseFrontmatter = (content: string): Frontmatter => {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match?.[1]) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { frontmatter, body: (match[2] ?? "").trim() };
};

/** The cast text lives after the frontmatter's `--` separator. */
export const extractCastText = (body: string): string => {
	const parts = body.split(/\n--\n/);
	return (parts[1] ?? body).trim();
};

export interface ArchiveStats {
	db_present: boolean;
	archived: number;
	users: number;
	purged: number;
	self_purged: number;
	backed_up: number;
	backed_up_verified: number;
	min_age_days: number;
	policy_source: string;
	casts_per_month: { month: string; count: number }[];
}

/** Index → ArchiveStats (the /api/archive/stats + browse-glance shape). */
export const statsFromIndex = (
	index: ArchiveIndex,
	policy: { minAgeDays: number; source: string },
	manifest: { verifiedHash: boolean; verifiedSig: boolean }[],
): ArchiveStats => {
	const castsEntries = Object.values(index.casts);
	const months = new Map<string, number>();
	for (const entry of castsEntries) {
		const month = new Date(entry[1]).toISOString().slice(0, 7);
		months.set(month, (months.get(month) ?? 0) + 1);
	}
	const tombstones = Object.values(index.deleted);
	return {
		db_present: true,
		archived: castsEntries.length,
		users: Object.keys(index.users).length,
		purged: tombstones.length,
		self_purged: tombstones.filter(([reason]) =>
			reason.startsWith("self-purge"),
		).length,
		backed_up: manifest.length,
		backed_up_verified: manifest.filter((m) => m.verifiedHash && m.verifiedSig)
			.length,
		min_age_days: policy.minAgeDays,
		policy_source: policy.source,
		casts_per_month: [...months.entries()]
			.map(([month, count]) => ({ month, count }))
			.sort((a, b) => a.month.localeCompare(b.month))
			.slice(-12),
	};
};
