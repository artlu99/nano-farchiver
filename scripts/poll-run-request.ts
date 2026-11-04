/**
 * Every-minute poller (cron): consume the run-request marker and execute
 * the archiver pipeline in-process. The marker is consumed BEFORE the run
 * (at-least-once semantics: a request arriving mid-run triggers the next
 * run); failures are logged, never retried in a loop — the hourly marker
 * re-arms the schedule anyway.
 *
 * Crontab wraps this in flock -n on logs/doit.lock, which is also the lock
 * the (optional) direct `bun run doIt` path uses — mutual exclusion between
 * poller runs and manual runs without any extra machinery.
 *
 *   * * * * * cd <repo> && flock -n logs/doit.lock bun scripts/poll-run-request.ts
 */

import { doIt } from "../src/index";
import { ARCHIVER_FID } from "../src/lib/config";
import { S3Store, s3ConfigFromEnv } from "../src/store/s3";

const RUN_REQUEST_KEY = "meta/run-request";

const store = new S3Store(s3ConfigFromEnv());
const marker = await store.get(RUN_REQUEST_KEY);
if (!marker) process.exit(0);

console.log(
	`run-request detected at ${new Date().toISOString()} — consuming marker, running`,
);
// Consume the marker BEFORE executing: requests arriving during the run are
// not lost (the next poller minute re-checks; the hourly cron re-arms anyway).
await store.deleteKey(RUN_REQUEST_KEY);

try {
	await doIt(Number(process.env.ARCHIVER_FID ?? ARCHIVER_FID));
	console.log(`run completed at ${new Date().toISOString()}`);
} catch (error) {
	console.error(
		`run FAILED at ${new Date().toISOString()}:`,
		error instanceof Error ? error.message : String(error),
	);
}
process.exit(0);
