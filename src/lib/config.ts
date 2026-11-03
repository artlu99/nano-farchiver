import { defaultRunContext, type RunContext } from "../ctx";
import { getDb } from "./db";

export const ARCHIVER_FID = Number(process.env.ARCHIVER_FID ?? 3319217);

const MIN_AGE_KEY = "purge_min_age_days";
const DEFAULT_MIN_AGE_DAYS = 7;

export interface PurgePolicy {
	minAgeDays: number;
	source: "settings" | "env" | "default";
}

const policyKeys = (fid?: number): string[] =>
	fid !== undefined ? [`${MIN_AGE_KEY}:${fid}`, MIN_AGE_KEY] : [MIN_AGE_KEY];

const fromStored = (value: string): PurgePolicy | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0
		? { minAgeDays: parsed, source: "settings" }
		: undefined;
};

const fromEnv = (): PurgePolicy | undefined => {
	const env = Number(process.env.PURGE_MIN_AGE_DAYS);
	return Number.isFinite(env) && env >= 0
		? { minAgeDays: env, source: "env" }
		: undefined;
};

/**
 * Effective purge policy. Precedence: fid-scoped settings row > global
 * settings row > PURGE_MIN_AGE_DAYS env > default. Publicly inspectable via
 * GET /api/policy — never treat as secret.
 */
export const getPolicy = async (options?: {
	fid?: number;
	ctx?: RunContext;
}): Promise<PurgePolicy> => {
	const ctx = options?.ctx ?? defaultRunContext();
	for (const key of policyKeys(options?.fid)) {
		const stored = await ctx.data.getSetting(key);
		const policy = stored !== undefined ? fromStored(stored) : undefined;
		if (policy) return policy;
	}
	return fromEnv() ?? { minAgeDays: DEFAULT_MIN_AGE_DAYS, source: "default" };
};

export const setPolicy = async (
	minAgeDays: number,
	options?: { fid?: number; ctx?: RunContext },
): Promise<PurgePolicy> => {
	if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
		throw new Error(`invalid min_age_days: ${minAgeDays}`);
	}
	const key =
		options?.fid !== undefined ? `${MIN_AGE_KEY}:${options.fid}` : MIN_AGE_KEY;
	const ctx = options?.ctx ?? defaultRunContext();
	await ctx.data.setSetting(key, String(minAgeDays));
	return { minAgeDays, source: "settings" };
};

/**
 * SQLite-only synchronous variant for the not-yet-ported sync read paths
 * (stats.ts, serve.ts). Transitional — goes away with the web-tier port
 * (MIGRATION.md stage 4), which reads settings objects async.
 */
export const getPolicySync = (fid?: number): PurgePolicy => {
	for (const key of policyKeys(fid)) {
		try {
			const row = getDb()
				.query("SELECT value FROM settings WHERE key = ?")
				.get(key) as { value: string } | undefined;
			const policy = row ? fromStored(row.value) : undefined;
			if (policy) return policy;
		} catch {
			// settings table unavailable — fall through to env/default
		}
	}
	return fromEnv() ?? { minAgeDays: DEFAULT_MIN_AGE_DAYS, source: "default" };
};
