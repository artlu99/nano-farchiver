import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { outKey } from "./store/indexModel";
import { type ArchiveStore, bytesToText } from "./store/types";

/**
 * Where rendered markdown goes. `castsLoop`/`fidsLoop`/self-heal render
 * through this so the same job code writes local files (SQLite backend,
 * today) or bucket objects (store backend, `out/<username>/<file>.md`).
 */
export interface RenderSink {
	/** Does the rendered file already exist (skip-if-rendered check)? */
	has(relPath: string): Promise<boolean>;
	/** Existing content, or null. Used by the skip-if-rendered rewrite check. */
	read(relPath: string): Promise<string | null>;
	/** Write the full file content (fs: mkdirs as needed; bucket: one PUT). */
	write(relPath: string, content: string): Promise<void>;
}

export class FsRenderSink implements RenderSink {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	async has(relPath: string): Promise<boolean> {
		return existsSync(join(this.root, relPath));
	}

	async read(relPath: string): Promise<string | null> {
		const path = join(this.root, relPath);
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	}

	async write(relPath: string, content: string): Promise<void> {
		const path = join(this.root, relPath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
}

export class StoreRenderSink implements RenderSink {
	private readonly store: ArchiveStore;

	constructor(store: ArchiveStore) {
		this.store = store;
	}

	async has(relPath: string): Promise<boolean> {
		return (await this.store.get(outKeyFromRel(relPath))) !== null;
	}

	async read(relPath: string): Promise<string | null> {
		const obj = await this.store.get(outKeyFromRel(relPath));
		return obj ? bytesToText(obj.body) : null;
	}

	async write(relPath: string, content: string): Promise<void> {
		await this.store.put(outKeyFromRel(relPath), content);
	}
}

/** `"<username>/<file>.md"` → the `out/<username>/<file>.md` bucket key. */
const outKeyFromRel = (relPath: string): string => {
	const index = relPath.indexOf("/");
	if (index < 0) return outKey(relPath, "");
	const username = relPath.slice(0, index);
	return outKey(username, relPath.slice(index + 1));
};
