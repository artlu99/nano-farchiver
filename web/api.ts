import { hash2filename, normalizeHash } from "../src/lib/helpers";
import { outKey, settingKey } from "../src/store/indexModel";
import { bytesToText } from "../src/store/types";
import { getIndex } from "./data";
import type { Env } from "./env";
import { archiverFid, getStore } from "./env";
import { type ArchiveStats, statsFromIndex } from "./page";

/** GET /api/cast/:hash — {markdown, filename} of the rendered file. */
export const castByHash = async (
	env: Env,
	rawHash: string,
): Promise<Response> => {
	const index = await getIndex(env);
	const hash = normalizeHash(rawHash);
	const entry = index.casts[hash];
	if (!entry) {
		return Response.json({ error: "cast not found" }, { status: 404 });
	}
	const username = index.users[String(entry[0])]?.username ?? `fid:${entry[0]}`;
	const filename = hash2filename(hash, new Date(entry[1]));
	const obj = await getStore(env).get(outKey(username, filename));
	if (!obj) {
		return Response.json(
			{ error: "markdown file not found in bucket" },
			{ status: 404 },
		);
	}
	return Response.json({
		markdown: bytesToText(obj.body),
		filename,
	});
};

/** GET /status — {outstanding, completed} from the index (+ optional ?fid=). */
export const status = async (
	env: Env,
	fidParam?: string,
): Promise<Response> => {
	const index = await getIndex(env);
	const fid = fidParam !== undefined ? Number(fidParam) : undefined;
	const completed = Object.values(index.rendered).reduce(
		(sum, files) => sum + Object.keys(files).length,
		0,
	);
	const casts = Object.entries(index.casts);
	const total =
		fid !== undefined && Number.isFinite(fid)
			? casts.filter(([, entry]) => entry[0] === fid).length
			: casts.length;
	const completedForFid =
		fid !== undefined && Number.isFinite(fid)
			? Object.entries(index.rendered)
					.filter(([username]) => {
						// usernames↔fids: count only files whose owner matches
						const user = index.users[String(fid)]?.username;
						return username === user;
					})
					.reduce((sum, [, files]) => sum + Object.keys(files).length, 0)
			: completed;
	const payload = {
		outstanding: Math.max(0, total - completedForFid),
		completed: completedForFid,
	};
	return Response.json(payload, {
		headers: {
			ETag: `"${await sha1Hex(JSON.stringify(payload))}"`,
			"Cache-Control": "private, max-age=0, must-revalidate",
		},
	});
};

/** GET /api/archive/stats — same shape as the Bun stack's. */
export const archiveStats = async (env: Env): Promise<ArchiveStats> => {
	const index = await getIndex(env);
	const store = getStore(env);
	const p = await policy(env);
	const manifestObj = await store.get("backups/manifest.jsonl");
	const manifest: { verifiedHash: boolean; verifiedSig: boolean }[] = [];
	if (manifestObj) {
		for (const line of bytesToText(manifestObj.body).split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as {
					verified?: { hash?: boolean; sig?: boolean };
				};
				manifest.push({
					verifiedHash: parsed.verified?.hash === true,
					verifiedSig: parsed.verified?.sig === true,
				});
			} catch {
				// skip malformed manifest lines
			}
		}
	}
	return statsFromIndex(index, p, manifest);
};

/** Purge policy from settings objects: fid-scoped > global > env > default 7d. */
export const policy = async (
	env: Env,
): Promise<{ minAgeDays: number; source: string }> => {
	const store = getStore(env);
	const fid = archiverFid(env);
	const keys = [`purge_min_age_days:${fid}`, "purge_min_age_days"];
	for (const key of keys) {
		const obj = await store.get(settingKey(key));
		if (!obj) continue;
		const parsed = Number(JSON.parse(bytesToText(obj.body)).value);
		if (Number.isFinite(parsed) && parsed >= 0) {
			return { minAgeDays: parsed, source: "settings" };
		}
	}
	const envValue = Number(env.PURGE_MIN_AGE_DAYS);
	if (Number.isFinite(envValue) && envValue >= 0) {
		return { minAgeDays: envValue, source: "env" };
	}
	return { minAgeDays: 7, source: "default" };
};

/** Web-worker SHA-1 for the /status ETag (WebCrypto — async, Workers-safe). */
const sha1Hex = async (input: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-1",
		new TextEncoder().encode(input),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};
