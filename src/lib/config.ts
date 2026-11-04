import { defaultRunContext, type RunContext } from "../ctx";
import {
	DEFAULT_MIN_AGE_DAYS,
	minAgeSettingKey,
	PURGE_MIN_AGE_KEY,
	type PurgePolicy,
	policyFromEnvValue,
	policyFromStored,
} from "./policy";

export const ARCHIVER_FID = Number(process.env.ARCHIVER_FID ?? 3319217);

export type { PurgePolicy };

const policyKeys = (fid?: number): string[] =>
	fid !== undefined
		? [minAgeSettingKey(fid), PURGE_MIN_AGE_KEY]
		: [PURGE_MIN_AGE_KEY];

/**
 * Effective purge policy for the purge CLI. Precedence: fid-scoped settings
 * row > global settings row > PURGE_MIN_AGE_DAYS env > default — the pure
 * core lives in lib/policy.ts (web/api.ts resolves the same rows from the
 * bucket).
 */
export const getPolicy = async (options?: {
	fid?: number;
	ctx?: RunContext;
}): Promise<PurgePolicy> => {
	const ctx = options?.ctx ?? defaultRunContext();
	const values: (string | undefined)[] = [];
	for (const key of policyKeys(options?.fid)) {
		values.push(await ctx.data.getSetting(key));
	}
	return (
		policyFromStored(values) ??
		policyFromEnvValue(process.env.PURGE_MIN_AGE_DAYS) ?? {
			minAgeDays: DEFAULT_MIN_AGE_DAYS,
			source: "default",
		}
	);
};
