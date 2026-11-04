import { escapeHtml, hash2filename } from "../src/lib/helpers";
import type { ArchiveIndex } from "../src/store/indexModel";
import { breadcrumb, renderPage } from "./page";

export interface TimelineOptions {
	limit: number;
	previewLength: number;
	spamaway: boolean;
	textfilters: string[];
}

const escapeRegExp = (s: string): string =>
	s.replace(/[.*+?${}()|[\]\\]/g, "\\$&");

const spamRegex = (words: string[]): RegExp | null => {
	const cleaned = words.map((w) => w.trim()).filter(Boolean);
	if (cleaned.length === 0) return null;
	return new RegExp(`\\b(?:${cleaned.map(escapeRegExp).join("|")})\\b`, "i");
};

const snippet = (preview: string, maxLen: number): string => {
	const t = preview.replace(/\s+/g, " ").trim();
	return t.length <= maxLen ? t : `${t.slice(0, maxLen)}…`;
};

/**
 * The global timeline, computed entirely from the index (previews ride along
 * in cast entries — no per-row object GETs). Same UTC-day grouping and
 * reply-hint shape as the Bun stack's /timeline.
 */
export const timelineHtml = (
	index: ArchiveIndex,
	options: TimelineOptions,
): Response => {
	const { limit, previewLength, spamaway } = options;
	const rx = spamaway ? spamRegex(options.textfilters) : null;

	const rows = Object.entries(index.casts)
		.map(([hash, entry]) => ({
			hash,
			fid: entry[0],
			ts: entry[1],
			parentHash: entry[2],
			preview: entry[5],
		}))
		.filter((row) => index.deleted[row.hash] === undefined)
		.filter((row) => {
			if (!rx) return true;
			return !rx.test(row.preview);
		})
		.sort((a, b) => b.ts - a.ts);

	const visible = rows.slice(0, limit);
	const usernameOf = (fid: number): string =>
		index.users[String(fid)]?.username ?? `fid:${fid}`;

	let body = `<div class="breadcrumb"><a href="/browse">out</a> / <span>timeline</span></div>`;
	body += `<h1>Timeline</h1>`;
	body += `<div class="timeline-controls"><label class="timeline-toggle"><input type="checkbox" id="spamaway-toggle"> <span>spamaway</span></label></div>`;
	body += `<p>Showing ${visible.length} latest casts</p>`;

	const days = new Map<string, typeof visible>();
	for (const row of visible) {
		const day = new Date(row.ts).toISOString().slice(0, 10);
		const arr = days.get(day) ?? [];
		arr.push(row);
		days.set(day, arr);
	}
	const sortedDays = [...days.keys()].sort().reverse();

	// spamaway toggle: checkbox reflects effective state; changing it rewrites
	// the URL param and reloads (server re-renders with the filter applied).
	// localStorage persists the choice across visits, mirroring the old
	// Bun stack's behavior.
	const spamawayScript = `
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

  input.checked = enabled;

  // Stored "off" but no param: server would treat as on — align URL with storage.
  if (!hasParam && enabled === false) {
    url.searchParams.set("spamaway", "0");
    location.replace(url.toString());
    return;
  }

  const DEBOUNCE_MS = 150;
  let refreshTimer = 0;
  input.addEventListener("change", () => {
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set("spamaway", input.checked ? "1" : "0");
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // Reload from backend (server-rendered timeline HTML).
      location.href = nextUrl.toString();
    }, DEBOUNCE_MS);
  });
})();
`;

	for (const day of sortedDays) {
		const dayRows = days.get(day) ?? [];
		body += `<h2 class="day" id="${escapeHtml(day)}">${escapeHtml(day)}</h2>`;
		for (const row of dayRows) {
			const username = usernameOf(row.fid);
			const basename = hash2filename(row.hash, new Date(row.ts));
			const href = `/browse/${encodeURIComponent(username)}/${encodeURIComponent(basename)}`;
			// forkcaster.xyz mirrors cast URLs (short or full hash) — same
			// external permalink the Bun stack's timeline rendered
			const forkHref = `https://forkcaster.xyz/${encodeURIComponent(username)}/${row.hash}`;
			body += `<article class="cast-row">`;
			body += `<div class="cast-meta"><a href="${escapeHtml(href)}">@${escapeHtml(username)}</a> · <code><a href="${escapeHtml(forkHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.hash.slice(0, 10))}</a></code></div>`;
			body += `<div class="cast-snippet">${escapeHtml(snippet(row.preview, previewLength))}</div>`;

			if (row.parentHash) {
				const parent = index.casts[row.parentHash];
				if (parent && index.deleted[row.parentHash] === undefined) {
					const parentUsername = usernameOf(parent[0]);
					const parentBasename = hash2filename(
						row.parentHash,
						new Date(parent[1]),
					);
					const parentHref = `/browse/${encodeURIComponent(parentUsername)}/${encodeURIComponent(parentBasename)}`;
					body += `<p class="reply-hint">↳ reply to <a href="${escapeHtml(parentHref)}">@${escapeHtml(parentUsername)}</a> — ${escapeHtml(snippet(parent[5], previewLength))}</p>`;
				} else {
					body += `<p class="reply-hint">↳ reply (parent unavailable)</p>`;
				}
			}
			body += `</article>`;
		}
	}

	body += `<script>${spamawayScript}</script>`;

	return renderPage({ title: "Timeline", bodyHtml: body });
};

export const timelineLink = (): string =>
	`<div class="breadcrumb"><a href="/browse">out</a> / <span>timeline</span></div>`;

export const timelineBreadcrumb = (): string => breadcrumb([]);
