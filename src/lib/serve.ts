import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix, resolve, sep } from "node:path";
import { marked } from "marked";

const OUT_DIR = resolve("out");

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
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1a1a1a}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
pre{background:#f4f4f4;padding:1rem;border-radius:4px;overflow-x:auto}
code{background:#f4f4f4;padding:.15rem .3rem;border-radius:3px;font-size:.9em}
img{max-width:100%}
dl{background:#f9fafb;padding:1rem;border-radius:4px;margin-bottom:1.5rem}
dt{font-weight:600}dd{margin:0 0 .25rem 1rem;color:#555}
.breadcrumb{margin-bottom:1.5rem;font-size:.9rem;color:#888}
.breadcrumb a{color:#888}.breadcrumb a:hover{color:#2563eb}
ul.entries{list-style:none;padding:0}
ul.entries li{padding:.25rem 0}
.dir{font-weight:600}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function breadcrumb(relativePath: string, filename?: string): string {
	const parts = relativePath ? relativePath.split("/").filter(Boolean) : [];
	let html = `<div class="breadcrumb"><a href="/browse">out</a>`;
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

function serveDirectory(dirPath: string, relativePath: string): Response {
	let entries: { name: string; isDir: boolean }[];
	try {
		const dirents = readdirSync(dirPath, { withFileTypes: true });
		entries = dirents
			.filter((d) => d.isDirectory() || d.name.endsWith(".md"))
			.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
			.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
	} catch {
		return new Response("not found", { status: 404 });
	}

	const title = relativePath || "out";
	let html = breadcrumb(relativePath);
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

	if (Object.keys(frontmatter).length > 0) {
		html += `<dl>`;
		for (const [key, value] of Object.entries(frontmatter)) {
			html += `<dt>${key}</dt><dd>${value}</dd>`;
		}
		html += `</dl>`;
	}

	html += marked(body);

	return new Response(renderPage(title, html), {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

export function serveBrowse(pathname: string): Response {
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
			return serveDirectory(resolved, relativePath);
		}
		if (stat.isFile()) {
			return serveFile(resolved, relativePath);
		}
	} catch {
		// fall through to 404
	}

	return new Response("not found", { status: 404 });
}
