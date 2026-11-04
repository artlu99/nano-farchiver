import { escapeHtml, hash2filename } from "../src/lib/helpers";
import type { ArchiveIndex } from "../src/store/indexModel";
import { breadcrumb, renderPage } from "./page";
import { getSpamScores, type ScoreFetcher } from "./spam-scores";

export interface TimelineOptions {
	limit: number;
	previewLength: number;
	spamaway: boolean;
	textfilters: string[];
	/** Hide casts scoring ≥ this % spam (Quilcast). 0 = off. */
	spamThreshold?: number;
	/** DI: score fetcher for tests (defaults to global fetch). */
	scoreFetcher?: ScoreFetcher;
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
export const timelineHtml = async (
	index: ArchiveIndex,
	options: TimelineOptions,
): Promise<Response> => {
	const {
		limit,
		previewLength,
		spamaway,
		spamThreshold = 0,
		scoreFetcher,
	} = options;
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

	// Score filtering (Quilcast) applies to the prefetch window only — one
	// batched lookup, ≤ 100 hashes; null/unscored casts stay visible.
	let window = rows.slice(0, limit * 2);
	if (spamThreshold > 0 && window.length > 0) {
		const hiddenHashes = new Set<string>();
		const scores = await getSpamScores(
			window.map((row) => row.hash),
			scoreFetcher,
		);
		for (const row of window) {
			const score = scores.get(row.hash);
			if (
				score !== null &&
				score !== undefined &&
				score * 100 >= spamThreshold
			) {
				hiddenHashes.add(row.hash);
			}
		}
		window = window.filter((row) => !hiddenHashes.has(row.hash));
	}

	const visible = window.slice(0, limit);
	const usernameOf = (fid: number): string =>
		index.users[String(fid)]?.username ?? `fid:${fid}`;

	let body = `<div class="breadcrumb"><a href="/browse">out</a> / <span>timeline</span></div>`;
	body += `<h1>Timeline</h1>`;
	body += `<div class="timeline-controls"><label class="timeline-toggle"><input type="checkbox" id="spamaway-toggle"> <span>spamaway</span></label><label class="timeline-slider">spam &ge; <input type="range" id="spam-threshold" min="0" max="100" step="5" value="${spamThreshold}"> <span id="spam-threshold-value">${spamThreshold}</span>%</label></div>`;
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
	const controlsScript = `
(() => {
  const SPAMAWAY_KEY = "nano-farchiver:timeline:spamaway";
  const THRESHOLD_KEY = "nano-farchiver:timeline:spam-threshold";
  const box = document.getElementById("spamaway-toggle");
  const slider = document.getElementById("spam-threshold");
  const value = document.getElementById("spam-threshold-value");
  const url = new URL(location.href);
  const hasSpamParam = url.searchParams.has("spamaway");
  const hasThresholdParam = url.searchParams.has("spam");

  let spamEnabled = true;
  let threshold = 0;
  try {
    const s = localStorage.getItem(SPAMAWAY_KEY);
    if (s === "0") spamEnabled = false;
    if (s === "1") spamEnabled = true;
    const t = Number(localStorage.getItem(THRESHOLD_KEY));
    if (Number.isFinite(t) && t >= 0) threshold = Math.min(100, Math.round(t));
  } catch {}

  if (box) box.checked = spamEnabled;
  if (slider) slider.value = String(threshold);
  if (value) value.textContent = String(threshold);

  // Align URL with stored prefs (one navigation at most).
  const needs = [];
  if (!hasSpamParam && !spamEnabled) needs.push(["spamaway", "0"]);
  if (!hasThresholdParam && threshold > 0) needs.push(["spam", String(threshold)]);
  if (needs.length > 0) {
    for (const [k, v] of needs) url.searchParams.set(k, v);
    location.replace(url.toString());
    return;
  }

  const apply = (params) => {
    for (const [k, v] of params) url.searchParams.set(k, v);
    location.replace(url.toString());
  };
  const DEBOUNCE_MS = 150;
  let timer = 0;
  const debouncedApply = (params) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => apply(params), DEBOUNCE_MS);
  };

  if (box) box.addEventListener("change", () => {
    debouncedApply([["spamaway", box.checked ? "1" : "0"]]);
  });
  if (slider) {
    slider.addEventListener("input", () => {
      if (value) value.textContent = slider.value;
    });
    slider.addEventListener("change", () => {
      debouncedApply([["spam", slider.value]]);
    });
  }
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

	body += `<script>${controlsScript}</script>`;

	return renderPage({ title: "Timeline", bodyHtml: body });
};

export const timelineLink = (): string =>
	`<div class="breadcrumb"><a href="/browse">out</a> / <span>timeline</span></div>`;

export const timelineBreadcrumb = (): string => breadcrumb([]);
