import { existsSync, rmSync } from "node:fs";
import { readManifest } from "../src/lib/backup";

// Guarded `bun clean`: db/ + out/ + out.tar.gz. backups/ deliberately survives
// (it lives outside db/), and self-heal re-renders manifest-backed casts on the
// next `bun doIt` — but wiping out/ still destroys the rendered archive, so we
// make that visible instead of silent.
const force = process.argv.includes("--force");

const fidEntries = readManifest().filter(
	(entry) => entry.fid === Number(process.env.ARCHIVER_FID ?? 3319217),
);
const outExists = existsSync("out");

if (fidEntries.length > 0 && !outExists && !force) {
	console.error(
		`refusing to clean: ${fidEntries.length} backed-up cast(s) (including purged ones) currently have no out/ render.\n` +
			"Run `bun run doIt` first — self-heal re-renders them from backups/ — or `bun run clean --force` to proceed anyway.",
	);
	process.exit(1);
}

rmSync("db", { recursive: true, force: true });
rmSync("out", { recursive: true, force: true });
rmSync("out.tar.gz", { force: true });
console.log("cleaned db/, out/, out.tar.gz (backups/ preserved)");
