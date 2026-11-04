/**
 * ?spam=NN query param (the timeline's spam-score slider): 0–100 percent
 * threshold. Malformed/missing values fall back to 0 (filter off).
 */
export const spamThresholdFromQuery = (raw: string | undefined): number => {
	if (raw === undefined || raw === "") return 0;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(100, Math.round(n));
};
