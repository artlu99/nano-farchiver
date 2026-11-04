/**
 * Set the inverted lockfile (run request): writes meta/run-request in the
 * archive bucket. The every-minute poller picks it up, runs the pipeline,
 * and removes it. Used by the hourly cron and (via the web worker's
 * /doIt → archiver binding) by the Run button.
 *
 *   bun scripts/set-run-request.ts
 */
import { S3Store, s3ConfigFromEnv } from "../src/store/s3";

const store = new S3Store(s3ConfigFromEnv());
await store.put(
	"meta/run-request",
	JSON.stringify({ requestedAt: Date.now() }),
);
console.log("run requested (meta/run-request set)");
