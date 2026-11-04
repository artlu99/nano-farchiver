/**
 * Build-time stub for the archiver/web Worker bundles: `bun:sqlite` exists
 * only in the Bun runtime. The Worker graph imports src/lib/db.ts transitively
 * (ctx defaultRunContext) but never executes SQLite paths — every Worker code
 * path passes an explicit RunContext. This stub satisfies the bundler.
 */
export class Database {
	constructor(_path?: string, _options?: unknown) {}
	prepare(): unknown {
		throw new Error("bun:sqlite is not available in Workers");
	}
	query(): unknown {
		throw new Error("bun:sqlite is not available in Workers");
	}
	run(): unknown {
		throw new Error("bun:sqlite is not available in Workers");
	}
	exec(): unknown {
		throw new Error("bun:sqlite is not available in Workers");
	}
	close(): void {}
	transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
		return fn as (...args: unknown[]) => T;
	}
}
export default Database;
