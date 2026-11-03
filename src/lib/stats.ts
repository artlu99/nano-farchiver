import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readManifest } from "./backup";
import { ARCHIVER_FID, getPolicySync } from "./config";

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

const LOCAL_STATS_TTL_MS = 60 * 1000;
let cache: { at: number; stats: ArchiveStats } | null = null;

/** Local-only counts (no network): fast enough for a public page view. */
export const archiveStats = (): ArchiveStats => {
	if (cache && Date.now() - cache.at < LOCAL_STATS_TTL_MS) return cache.stats;
	// sync sqlite path until the web-tier port (see getPolicySync)
	const policy = getPolicySync();
	if (!existsSync("db/queue.db3")) {
		return {
			db_present: false,
			archived: 0,
			users: 0,
			purged: 0,
			self_purged: 0,
			backed_up: 0,
			backed_up_verified: 0,
			min_age_days: policy.minAgeDays,
			policy_source: policy.source,
			casts_per_month: [],
		};
	}
	const db = new Database("db/queue.db3", { readonly: true });
	try {
		const archived = (
			db.query("SELECT count(1) as n FROM casts").get() as { n: number }
		).n;
		const users = (
			db.query("SELECT count(1) as n FROM users").get() as { n: number }
		).n;
		const purged = (
			db.query("SELECT count(1) as n FROM deleted_casts").get() as { n: number }
		).n;
		const selfPurged = (
			db
				.query(
					"SELECT count(1) as n FROM deleted_casts WHERE reason LIKE 'self-purge%'",
				)
				.get() as { n: number }
		).n;
		const months = db
			.query(
				`SELECT substr(json_extract(data, '$.timestamp'), 1, 7) as month, count(1) as n
				 FROM casts
				 WHERE month IS NOT NULL
				 GROUP BY month ORDER BY month DESC LIMIT 12`,
			)
			.all() as { month: string; n: number }[];
		const entries = readManifest().filter((e) => e.fid === ARCHIVER_FID);
		const stats: ArchiveStats = {
			db_present: true,
			archived,
			users,
			purged,
			self_purged: selfPurged,
			backed_up: entries.length,
			backed_up_verified: entries.filter(
				(e) => e.verified.hash && e.verified.sig,
			).length,
			min_age_days: policy.minAgeDays,
			policy_source: policy.source,
			casts_per_month: months
				.reverse()
				.map((m) => ({ month: m.month, count: m.n })),
		};
		cache = { at: Date.now(), stats };
		return stats;
	} finally {
		db.close();
	}
};

export const statsHtml = (stats: ArchiveStats): string => {
	if (!stats.db_present) {
		return `<p class="glance-note">archive database not found — run <code>bun run doIt</code></p>`;
	}
	const maxCount = Math.max(1, ...stats.casts_per_month.map((m) => m.count));
	const tiles = [
		["archived", stats.archived.toLocaleString()],
		["purged", stats.purged.toLocaleString()],
		[
			"backed up",
			stats.backed_up_verified
				? `${stats.backed_up_verified.toLocaleString()}✓ / ${stats.backed_up.toLocaleString()}`
				: stats.backed_up.toLocaleString(),
		],
		["min-age policy", `${stats.min_age_days}d (${stats.policy_source})`],
		["users", stats.users.toLocaleString()],
	]
		.map(
			([label, value]) =>
				`<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`,
		)
		.join("");
	const bars = stats.casts_per_month
		.map(
			({ month, count }) =>
				`<div class="hist-col" title="${month}: ${count}"><div class="hist-bar" style="height:${Math.max(2, Math.round((count / maxCount) * 100))}%"></div><div class="hist-label">${month.slice(2)}</div></div>`,
		)
		.join("");
	return `<div class="glance">
  <div class="stat-row">${tiles}</div>
  ${stats.casts_per_month.length > 0 ? `<div class="hist-row">${bars}</div>` : ""}
</div>`;
};
