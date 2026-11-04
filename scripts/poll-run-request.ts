/**
 * Every-minute poller (cron): consume the run-request marker and execute
 * one bounded tick of the archiver pipeline. The marker is consumed BEFORE
 * the run (at-least-once semantics); failures are logged, never retried in
 * a loop — the hourly marker re-arms the schedule anyway. Progress is
 * written to meta/run-status.json for the web worker's /runs live view.
 *
 * Crontab wraps this in flock -n on logs/doit.lock — mutual exclusion with
 * any direct `bun run doIt` without extra machinery.
 *
 *   * * * * * cd <repo> && flock -n logs/doit.lock bun scripts/poll-run-request.ts
 */
import { runtimeContext } from "../src/ctx";
import { runTick } from "../src/jobs/tick";
import { ARCHIVER_FID } from "../src/lib/config";
import { runRequestKey, writeRunStatus } from "../src/store/indexModel";
import { S3Store, s3ConfigFromEnv } from "../src/store/s3";

const fid = ARCHIVER_FID;
const store = new S3Store(s3ConfigFromEnv());

const marker = await store.get(runRequestKey);
if (!marker) process.exit(0);

console.log(
	`run-request detected at ${new Date().toISOString()} — consuming marker, running`,
);
await store.deleteKey(runRequestKey);

let lastPush = 0;
let pendingWrite: Promise<unknown> = Promise.resolve();
try {
	console.log("run starting (up to 2 attempts for transient upstream errors)");
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const result = await runTick(fid, runtimeContext(), {
				onProgress: (progress) => {
					// throttle status writes to ~1/2s (R2 Class A budget);
					// terminal events (running:false) always write — dropping
					// one would leave the status object stuck mid-run forever
					const now = Date.now();
					if (progress.running && now - lastPush < 2_000) return;
					lastPush = now;
					pendingWrite = writeRunStatus(store, progress).catch(() => {});
				},
			});
			// process.exit kills in-flight promises — land the terminal
			// status write first
			await pendingWrite;
			console.log(
				`run completed at ${new Date().toISOString()}: ${result.renders} renders, ${result.hydrated} hydrated, ${result.failures} failures`,
			);
			process.exit(0);
		} catch (error) {
			await pendingWrite;
			console.error(
				`attempt ${attempt} FAILED at ${new Date().toISOString()}:`,
				error instanceof Error ? error.message : String(error),
			);
			if (attempt < 2) {
				console.log("retrying in 30s…");
				await new Promise((r) => setTimeout(r, 30_000));
			}
		}
	}
	console.error(`run FAILED after 2 attempts — hourly cron will retry`);
} catch (error) {
	console.error(
		`poller error at ${new Date().toISOString()}:`,
		error instanceof Error ? error.message : String(error),
	);
}
process.exit(0);
