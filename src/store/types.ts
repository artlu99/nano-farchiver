export interface StoredObject {
	body: Uint8Array;
	etag?: string;
}

export interface PutOptions {
	/** Require the stored object's current ETag to match (conditional overwrite). */
	ifMatch?: string;
	/** `"*"` = create-only; otherwise require a matching ETag. */
	ifNoneMatch?: string;
}

export interface PutResult {
	etag?: string;
}

export interface ListPage {
	keys: string[];
	prefixes: string[];
	truncated: boolean;
	nextToken?: string;
}

export interface ListOptions {
	/** Group keys by this separator into `prefixes` (simulates "directories"). */
	delimiter?: string;
	maxKeys?: number;
	token?: string;
}

export class PreconditionFailedError extends Error {
	constructor(key: string) {
		super(`precondition failed for ${key}`);
		this.name = "PreconditionFailedError";
	}
}

/**
 * The ONLY bucket API used anywhere (MIGRATION.md §3.1). Plain S3-object verbs so
 * the same code runs against R2, AWS S3, Tigris, Backblaze B2 and Garage.
 */
export interface ArchiveStore {
	get(key: string): Promise<StoredObject | null>;
	put(
		key: string,
		data: Uint8Array | string,
		options?: PutOptions,
	): Promise<PutResult>;
	/** Idempotent: deleting a missing key is a no-op. */
	deleteKey(key: string): Promise<void>;
	list(prefix: string, options?: ListOptions): Promise<ListPage>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const textToBytes = (text: string): Uint8Array => encoder.encode(text);
export const bytesToText = (bytes: Uint8Array): string => decoder.decode(bytes);
