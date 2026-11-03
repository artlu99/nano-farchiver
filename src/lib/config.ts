import { getDb } from "./db";

export const ARCHIVER_FID = Number(process.env.ARCHIVER_FID ?? 3319217);

const MIN_AGE_KEY = "purge_min_age_days";
const DEFAULT_MIN_AGE_DAYS = 7;

export interface PurgePolicy {
	minAgeDays: number;
	source: "settings" | "env" | "default";
}

/**
 * Effective purge policy. Precedence: fid-scoped settings row > global settings
 * row > PURGE_MIN_AGE_DAYS env > default. Publicly inspectable via GET
 * /api/policy — never treat as secret. (Sync until the purge surface moves to
 * the bucket store; the web tier reads the same settings objects async.)
 */
export const getPolicy = (fid?: number): PurgePolicy => {
	const keys =
		fid !== undefined ? [`${MIN_AGE_KEY}:${fid}`, MIN_AGE_KEY] : [MIN_AGE_KEY];
	for (const key of keys) {
		try {
			const row = getDb()
				.query("SELECT value FROM settings WHERE key = ?")
				.get(key) as { value: string } | undefined;
			const parsed = row ? Number(row.value) : Number.NaN;
			if (Number.isFinite(parsed) && parsed >= 0) {
				return { minAgeDays: parsed, source: "settings" };
			}
		} catch {
			// settings table unavailable — fall through to env/default
		}
	}
	const env = Number(process.env.PURGE_MIN_AGE_DAYS);
	if (Number.isFinite(env) && env >= 0) {
		return { minAgeDays: env, source: "env" };
	}
	return { minAgeDays: DEFAULT_MIN_AGE_DAYS, source: "default" };
};

export const setPolicy = (minAgeDays: number, fid?: number): PurgePolicy => {
	if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
		throw new Error(`invalid min_age_days: ${minAgeDays}`);
	}
	const key = fid !== undefined ? `${MIN_AGE_KEY}:${fid}` : MIN_AGE_KEY;
	getDb()
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		)
		.run(key, String(minAgeDays), Date.now());
	return { minAgeDays, source: "settings" };
};
