/**
 * Purge-policy resolution — the pure, storage-layer-free core (Workers-safe:
 * no ctx, no bun:sqlite). The web worker resolves the settings rows straight
 * from the bucket (web/api.ts); the purge CLI goes through ctx.data
 * (lib/config.ts). Shared precedence contract:
 *   fid-scoped settings row > global settings row > PURGE_MIN_AGE_DAYS env
 *   > 7-day default. Publicly inspectable via GET /api/policy — never treat
 * as secret.
 */
export const PURGE_MIN_AGE_KEY = "purge_min_age_days";
export const DEFAULT_MIN_AGE_DAYS = 7;

export interface PurgePolicy {
	minAgeDays: number;
	source: "settings" | "env" | "default";
}

export const minAgeSettingKey = (fid?: number): string =>
	fid !== undefined ? `${PURGE_MIN_AGE_KEY}:${fid}` : PURGE_MIN_AGE_KEY;

/** First parseable non-negative stored value wins; undefined entries are absent rows. */
export const policyFromStored = (
	values: (string | undefined)[],
): PurgePolicy | undefined => {
	for (const value of values) {
		if (value === undefined) continue;
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) {
			return { minAgeDays: parsed, source: "settings" };
		}
	}
	return undefined;
};

export const policyFromEnvValue = (
	value: string | undefined,
): PurgePolicy | undefined => {
	const env = Number(value);
	return Number.isFinite(env) && env >= 0
		? { minAgeDays: env, source: "env" }
		: undefined;
};
