import { marked } from "marked";
import { escapeHtml } from "../src/lib/helpers";

import type { ArchiveStore } from "../src/store/types";
import {
	breadcrumb,
	extractCastText,
	parseFrontmatter,
	renderPage,
	type StatTile,
	statsHtml,
} from "./page";

/** Username directories under out/ (ListObjectsV2 with a delimiter). */
export const listUsernames = async (store: ArchiveStore): Promise<string[]> => {
	const page = await store.list("out/", { delimiter: "/" });
	return page.prefixes
		.map((prefix) => prefix.replace(/^out\//, "").replace(/\/$/, ""))
		.sort((a, b) => a.localeCompare(b));
};

/** Rendered files for one user, newest first (names start with YYYYMMDD). */
export const listUserFiles = async (
	store: ArchiveStore,
	username: string,
): Promise<string[]> => {
	const prefix = `out/${username}/`;
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const page = await store.list(prefix, { maxKeys: 1000, token });
		for (const key of page.keys) {
			if (key.endsWith(".md")) keys.push(key.slice(prefix.length));
		}
		token = page.truncated ? page.nextToken : undefined;
	} while (token);
	return keys.sort((a, b) => b.localeCompare(a));
};

const entryLink = (
	username: string,
	filename: string,
	isDir: boolean,
): string => {
	const href = `/browse/${encodeURIComponent(username)}${filename ? `/${encodeURIComponent(filename)}` : "/"}`;
	const cls = isDir ? ` class="dir"` : "";
	return `<li${cls}><a href="${href}">${escapeHtml(isDir ? `${username}/` : filename)}</a></li>`;
};

export const browseRootHtml = (
	usernames: string[],
	tiles: StatTile[],
	histogram: { month: string; count: number }[],
	totalFiles: number,
): Response => {
	let body = breadcrumb([]);
	try {
		body += statsHtml(tiles, histogram);
	} catch {
		// glance is best-effort — never break the listing
	}
	body += `<h1>out</h1><p>${usernames.length} entries · ${totalFiles} rendered casts</p>`;
	body += `<ul class="entries">${usernames
		.map((u) => entryLink(u, "", true))
		.join("")}</ul>`;
	return renderPage({ title: "out", bodyHtml: body });
};

export const browseUserHtml = (username: string, files: string[]): Response => {
	let body = breadcrumb([username]);
	body += `<h1>${escapeHtml(username)}</h1><p>${files.length} ${
		files.length === 1 ? "entry" : "entries"
	}</p>`;
	body += `<ul class="entries">${files
		.map((f) => entryLink(username, f, false))
		.join("")}</ul>`;
	return renderPage({ title: username, bodyHtml: body });
};

/** Markdown file → HTML page (frontmatter table + marked body). */
export const browseFileHtml = (
	markdown: string,
	username: string,
	filename: string,
): Response => {
	const { frontmatter, body } = parseFrontmatter(markdown);
	const title = filename.replace(/\.md$/, "");

	let html = breadcrumb([username, filename]);
	html += marked(body);

	if (Object.keys(frontmatter).length > 0) {
		html += `<dl>`;
		for (const [key, value] of Object.entries(frontmatter)) {
			html += `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`;
		}
		html += `</dl>`;
	}
	return renderPage({ title, bodyHtml: html });
};

/** Truncated preview + x402 pay link (pre-paywall state of a gated file). */
export const browsePreviewHtml = (
	markdown: string,
	username: string,
	filename: string,
	previewLength: number,
): Response => {
	const { frontmatter, body } = parseFrontmatter(markdown);
	const castText = extractCastText(body);
	const truncated = castText.slice(0, previewLength);
	const href = `/browse/${encodeURIComponent(username)}/${encodeURIComponent(filename)}?pay=1`;

	let html = breadcrumb([username, filename]);
	html += `<div class="preview">`;
	html += `<p class="preview-text">${escapeHtml(truncated)}${castText.length > previewLength ? "..." : ""}</p>`;
	html += `<a class="pay-link" href="${escapeHtml(href)}">Read full cast via x402</a>`;
	html += `</div>`;
	if (Object.keys(frontmatter).length > 0) {
		html += `<dl>${Object.entries(frontmatter)
			.map(
				([key, value]) =>
					`<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`,
			)
			.join("")}</dl>`;
	}
	return renderPage({ title: filename.replace(/\.md$/, ""), bodyHtml: html });
};

export const notFoundHtml = (): Response =>
	new Response("not found", { status: 404 });
