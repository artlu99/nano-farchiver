import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix, resolve, sep } from "node:path";
import { marked } from "marked";
import invariant from "tiny-invariant";
import { archiveStats, statsHtml } from "./stats";

const OUT_DIR = resolve("out");

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function extractCastText(body: string): string {
	const parts = body.split(/\n--\n/);
	if (parts.length >= 2) {
		invariant(parts[1] !== undefined, "parts[1] is undefined");
		return parts[1].trim();
	}
	return body.trim();
}

function parseFrontmatter(content: string): {
	frontmatter: Record<string, string>;
	body: string;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match?.[1]) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { frontmatter, body: (match[2] ?? "").trim() };
}

function renderPage(title: string, bodyHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — nano-farchiver</title>
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
.glance-note{color:var(--muted);font-size:.9rem}
.stat-row{display:flex;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem}
.stat-tile{background:var(--surface);border-radius:4px;padding:.6rem 1rem;min-width:7rem}
.stat-value{font-weight:600;font-size:1.15rem}
.stat-label{color:var(--muted);font-size:.8rem}
.hist-row{display:flex;align-items:flex-end;gap:2px;height:5rem;background:var(--surface);padding:.75rem;border-radius:4px}
.hist-col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;height:100%}
.hist-bar{width:100%;background:var(--accent-border);border-radius:1px 1px 0 0}
.hist-label{font-size:.55rem;color:var(--muted);margin-top:.25rem}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function breadcrumb(relativePath: string, filename?: string): string {
	const parts = relativePath ? relativePath.split("/").filter(Boolean) : [];
	let html =
		parts.length === 0 && !filename
			? `<div class="breadcrumb"><a href="/">home</a>`
			: `<div class="breadcrumb"><a href="/browse">out</a>`;
	for (let i = 0; i < parts.length; i++) {
		const href = posix.join("/browse", ...parts.slice(0, i + 1));
		html += ` / <a href="${href}">${parts[i]}</a>`;
	}
	if (filename) {
		html += ` / ${basename(filename, ".md")}`;
	}
	html += `</div>`;
	return html;
}

function serveDirectory(
	dirPath: string,
	relativePath: string,
	titleText?: string,
): Response {
	let entries: { name: string; isDir: boolean }[];
	try {
		const dirents = readdirSync(dirPath, { withFileTypes: true });
		entries = dirents
			.filter((d) => d.isDirectory() || d.name.endsWith(".md"))
			.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
			.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				if (a.isDir && b.isDir) return a.name.localeCompare(b.name);
				return b.name.localeCompare(a.name);
			});
	} catch {
		return new Response("not found", { status: 404 });
	}

	const title = titleText || relativePath || "out";
	let html = breadcrumb(relativePath);
	if (relativePath === "") {
		try {
			html += statsHtml(archiveStats());
		} catch {
			// glance is best-effort — never break the listing
		}
	}
	html += `<h1>${basename(dirPath)}</h1>`;
	html += `<p>${entries.length} ${entries.length === 1 ? "entry" : "entries"}</p>`;
	html += `<ul class="entries">`;
	for (const entry of entries) {
		const href =
			posix.join("/browse", relativePath, entry.name) +
			(entry.isDir ? "/" : "");
		const cls = entry.isDir ? ' class="dir"' : "";
		html += `<li${cls}><a href="${href}">${entry.name}${entry.isDir ? "/" : ""}</a></li>`;
	}
	html += `</ul>`;

	return new Response(renderPage(title, html), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

function serveFile(filePath: string, relativePath: string): Response {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return new Response("not found", { status: 404 });
	}

	const { frontmatter, body } = parseFrontmatter(content);
	const title = basename(filePath, ".md");

	let html = breadcrumb(relativePath, filePath);

	html += marked(body);

	if (Object.keys(frontmatter).length > 0) {
		html += `<dl>`;
		for (const [key, value] of Object.entries(frontmatter)) {
			html += `<dt>${key}</dt><dd>${value}</dd>`;
		}
		html += `</dl>`;
	}

	return new Response(renderPage(title, html), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

export function serveBrowse(pathname: string, titleText?: string): Response {
	const relativePath = decodeURIComponent(
		pathname === "/browse" || pathname === "/browse/"
			? ""
			: pathname.slice("/browse/".length),
	).replace(/\/+$/, "");
	const resolved = resolve(join(OUT_DIR, relativePath));

	if (!resolved.startsWith(OUT_DIR + sep) && resolved !== OUT_DIR) {
		return new Response("forbidden", { status: 403 });
	}

	try {
		const stat = statSync(resolved);
		if (stat.isDirectory()) {
			return serveDirectory(resolved, relativePath, titleText);
		}
		if (stat.isFile()) {
			return serveFile(resolved, relativePath);
		}
	} catch {
		// fall through to 404
	}

	return new Response("not found", { status: 404 });
}

export function serveBrowseFile(pathname: string): Response {
	const relativePath = decodeURIComponent(
		pathname.slice("/browse/".length),
	).replace(/\/+$/, "");
	const resolved = resolve(join(OUT_DIR, relativePath));

	if (!resolved.startsWith(OUT_DIR + sep)) {
		return new Response("forbidden", { status: 403 });
	}

	try {
		const stat = statSync(resolved);
		if (stat.isFile()) {
			return serveFile(resolved, relativePath);
		}
	} catch {
		// fall through to 404
	}

	return new Response("not found", { status: 404 });
}

export function servePreview(
	pathname: string,
	previewLength: number,
): Response {
	const relativePath = decodeURIComponent(
		pathname.slice("/browse/".length),
	).replace(/\/+$/, "");
	const resolved = resolve(join(OUT_DIR, relativePath));

	if (!resolved.startsWith(OUT_DIR + sep)) {
		return new Response("forbidden", { status: 403 });
	}

	let content: string;
	try {
		content = readFileSync(resolved, "utf-8");
	} catch {
		return new Response("not found", { status: 404 });
	}

	const { frontmatter, body } = parseFrontmatter(content);
	const title = basename(resolved, ".md");
	const castText = extractCastText(body);
	const truncated = castText.slice(0, previewLength);

	let html = breadcrumb(relativePath, resolved);

	html += `<div class="preview">`;
	html += `<p class="preview-text">${escapeHtml(truncated)}${castText.length > previewLength ? "..." : ""}</p>`;
	html += `<a class="pay-link" href="${pathname}?pay=1">Read full cast via x402</a>`;
	html += `</div>`;

	if (Object.keys(frontmatter).length > 0) {
		html += `<dl>`;
		for (const [key, value] of Object.entries(frontmatter)) {
			html += `<dt>${key}</dt><dd>${value}</dd>`;
		}
		html += `</dl>`;
	}

	return new Response(renderPage(title, html), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}
