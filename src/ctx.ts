import { SqliteArchiveData } from "./data/sqlite";
import { StoreArchiveData } from "./data/store";
import type { ArchiveData } from "./data/types";
import type { User } from "./lib/helpers";
import { FsRenderSink, type RenderSink, StoreRenderSink } from "./sink";
import type { ArchiveStore } from "./store/types";

/**
 * Per-run state that used to live in module globals (jobs/read.ts
 * `missingCastHashes` + `userCache`), bundled with the data backend. Module
 * globals are cross-request state in a Worker — everything jobs/ does now
 * goes through a context; the default context keeps the old single-process
 * behavior until cutover.
 */
export interface RunContext {
	readonly data: ArchiveData;
	readonly missingCastHashes: Set<string>;
	readonly userCache: Map<number, User>;
	/** Render target: local out/ root for SQLite, bucket objects for store. */
	readonly out: (root: string) => RenderSink;
}

export const createSqliteRunContext = (): RunContext => ({
	data: new SqliteArchiveData(),
	missingCastHashes: new Set(),
	userCache: new Map(),
	out: (root: string) => new FsRenderSink(root),
});

export const createStoreRunContext = (store: ArchiveStore): RunContext => ({
	data: new StoreArchiveData(store),
	missingCastHashes: new Set(),
	userCache: new Map(),
	out: () => new StoreRenderSink(store),
});

let defaultContext: RunContext | undefined;

/**
 * The implicit context for call sites that don't pass one (server.ts, purge,
 * backup, existing tests). Safe to memoize: SqliteArchiveData methods resolve
 * `getDb()` per call, so `initDb(":memory:")` in tests keeps working.
 */
export const defaultRunContext = (): RunContext =>
	(defaultContext ??= createSqliteRunContext());
