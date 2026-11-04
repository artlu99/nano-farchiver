import { S3Store } from "../src/store/s3";
import type { ArchiveStore } from "../src/store/types";

/**
 * Bindings for the read-only `web` Worker (web/wrangler.jsonc).
 * Secrets go through `wrangler secret put`: S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, X402_API_KEY.
 */
export interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> };
	/** Service binding: facilitator worker (workers.dev fetch is blocked). */
	FACILITATOR: { fetch(request: Request): Promise<Response> };
	/** Service binding: archiver worker (sets the run-request marker). */
	ARCHIVER: { fetch(request: Request): Promise<Response> };
	S3_ENDPOINT: string;
	S3_BUCKET: string;
	S3_REGION?: string;
	S3_ACCESS_KEY_ID: string;
	S3_SECRET_ACCESS_KEY: string;
	ARCHIVER_FID?: string;
	/** Base URL of the archiver service — superseded by the ARCHIVER binding. */
	ARCHIVER_URL?: string;
	PURGE_MIN_AGE_DAYS?: string;
	/** The one username whose files sit behind the x402 paywall. */
	X402_USERNAME?: string;
	X402_API_KEY?: string;
	X402_ALLOWLIST?: string;
	X402_MAX_TIMEOUT_SECONDS?: string;
}

let storeOverride: ArchiveStore | undefined;

/** Test hook: use an in-memory backend instead of a real S3Store. */
export const setStore = (s: ArchiveStore): void => {
	storeOverride = s;
};

export const getStore = (env: Env): ArchiveStore => {
	storeOverride ??= new S3Store({
		endpoint: env.S3_ENDPOINT,
		bucket: env.S3_BUCKET,
		region: env.S3_REGION ?? "auto",
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
	});
	return storeOverride;
};

export const archiverFid = (env: Env): number =>
	Number(env.ARCHIVER_FID ?? 3319217);

export const gatedUsername = (env: Env): string =>
	env.X402_USERNAME ?? "decent-artlu";
