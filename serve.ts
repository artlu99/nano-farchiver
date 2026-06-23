import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import legacy from "./server";

import reactIndex from "./react/index.html";

const PORT = Number(process.env.PORT ?? 3000);

const REACT_DIR = resolve("react");

function safeResolveReactPath(pathname: string): string | undefined {
	const relative = pathname.slice("/react/".length);
	const decoded = decodeURIComponent(relative).replace(/^\/+/, "");
	const resolved = resolve(join(REACT_DIR, decoded));
	if (!resolved.startsWith(REACT_DIR + sep) && resolved !== REACT_DIR) return undefined;
	return resolved;
}

Bun.serve({
	port: PORT,
	routes: {
		"/react": reactIndex,
		"/react/": reactIndex,
	},
	async fetch(req) {
		const { pathname } = new URL(req.url);

		if (pathname.startsWith("/react/")) {
			const resolved = safeResolveReactPath(pathname);
			if (!resolved) return new Response("Not found", { status: 404 });
			try {
				if (statSync(resolved).isDirectory()) {
					return Response.redirect("/react/", 307);
				}
				return new Response(Bun.file(resolved));
			} catch {
				return new Response("Not found", { status: 404 });
			}
		}

		return legacy.fetch(req);
	},
});

console.log(`[nano-farchiver] server listening on http://localhost:${PORT}`);

