import {
	type ArchiveStore,
	type ListOptions,
	type ListPage,
	PreconditionFailedError,
	type PutOptions,
	type PutResult,
	type StoredObject,
	textToBytes,
} from "./types";

interface Entry {
	data: Uint8Array;
	etag: string;
}

/**
 * In-memory ArchiveStore — the hermetic successor of `initDb(":memory:")` in
 * tests, and the dry-run engine for scripts/import-to-s3.ts. `maxKeys`/`token`
 * list options are accepted but ignored (full listings, tests never paginate).
 */
export class MemoryStore implements ArchiveStore {
	private readonly objects = new Map<string, Entry>();
	private counter = 0;

	private nextEtag(): string {
		this.counter += 1;
		return `mem-${this.counter}`;
	}

	async get(key: string): Promise<StoredObject | null> {
		const entry = this.objects.get(key);
		if (!entry) return null;
		return { body: entry.data.slice(), etag: entry.etag };
	}

	async put(
		key: string,
		data: Uint8Array | string,
		options?: PutOptions,
	): Promise<PutResult> {
		const bytes = typeof data === "string" ? textToBytes(data) : data;
		const existing = this.objects.get(key);
		if (options?.ifMatch && existing?.etag !== options.ifMatch) {
			throw new PreconditionFailedError(key);
		}
		if (options?.ifNoneMatch) {
			const matches =
				options.ifNoneMatch === "*"
					? !!existing
					: existing?.etag !== options.ifNoneMatch;
			if (matches) throw new PreconditionFailedError(key);
		}
		const etag = this.nextEtag();
		this.objects.set(key, { data: bytes.slice(), etag });
		return { etag };
	}

	async deleteKey(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async list(prefix: string, options?: ListOptions): Promise<ListPage> {
		const sorted = [...this.objects.keys()].sort();
		const keys: string[] = [];
		const prefixSet = new Set<string>();
		const delimiter = options?.delimiter;
		for (const key of sorted) {
			if (!key.startsWith(prefix)) continue;
			if (delimiter) {
				const rest = key.slice(prefix.length);
				const index = rest.indexOf(delimiter);
				if (index >= 0) {
					prefixSet.add(key.slice(0, prefix.length + index + delimiter.length));
					continue;
				}
			}
			keys.push(key);
		}
		return { keys, prefixes: [...prefixSet].sort(), truncated: false };
	}
}
