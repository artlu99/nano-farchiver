# nano-farchiver

**[Farchiver](https://farchiver.xyz)** uses direct access to the network, and can never be blocked due to modularity, and ability to re-route to multiple data sources.

 However, it is quite expensive to run that way.

`nano farchiver` is a weekend project that leverages free + paid SAAS. It may be censorable, but it costs very little.

## Shape of the system

One S3-compatible bucket (`nano-farchiver`) is the contract between three pieces:

- **Archiver pipeline** (`src/`, Bun) — fetch → tag → heal → render. Rendered files land
  as bucket objects and all index mutations coalesce into ONE `meta/index.json` PUT per
  run: a crashed run loses only the buffer; objects persist and the next run re-tags
  (self-healing by re-crawl). Production runs on a server: an hourly cron sets the
  `meta/run-request` marker (`scripts/cron-set-run-request.sh`), and an every-minute
  poller consumes it (`scripts/poll-run-request.ts`) under `flock -n logs/doit.lock`.
  **Single-writer rule:** never run two `doIt`/purge writers concurrently — a second
  writer can corrupt `meta/index.json`.
- **Web worker** (`web/`, read-only, live at
  [farchiver-web.artlu.workers.dev](https://farchiver-web.artlu.workers.dev)) —
  `/browse`, `/timeline`, `/api/*` served straight from the bucket; x402 paywall on the
  one gated username; `POST /doIt` asks the archiver worker (service binding) to set the
  run-request marker.
- **Archiver worker** (`archiver/`) — the pipeline sliced into a bounded tick behind a
  bucket lock: `POST /runs`, the marker endpoint `POST /runs/request`, live progress at
  `GET /runs/status`. No Workers cron trigger — execution stays on the server
  cron/poller.

`backups/` is git-tracked — this repo is the archive's offsite copy. `MIGRATION.md` has
the full architecture; `PLAN.md` has the purge design + hard invariants.

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```
2. **Bucket credentials** in `.env` (Bun auto-loads it):
   `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
   `S3_REGION` (default `auto`).
3. **FID to archive:** set `ARCHIVER_FID` (default `3319217`) — env, shared by the
   archiver and the web worker. No source editing.

## Scripts

Everything runs through `package.json` scripts:

| Script | What it does |
|---|---|
| `bun run doIt` | One archiver run: fetch → tag → heal → render → bucket (needs `S3_*`) |
| `bun run backup:all` | Raw backup + gate of all live casts (no deletes) |
| `bun run backup:verify [--sample N]` | Re-run the cryptographic gate on manifest backups; exit 1 on failures |
| `bun run backup:checkpoint` | Offsite sync (git push / rsync) + `CHECKPOINT.json` |
| `bun run purge:run` | Purge loop — **dry-run is the default**: lists candidates + gate results, deletes nothing |
| `bun run purge:run --live [N]` | Live deletes, up to N (or `PURGE_MAX_BATCH`); auto-checkpoints first; needs `FARCASTER_SIGNER_PRIVATE_KEY` |
| `bun run import:s3` | Backfill the bucket from the legacy local SQLite archive (`db/queue.db3`, read-only) |
| `bun run import:s3 --dry-run` | Full import pipeline against MemoryStore — no network |
| `bun run import:s3 --only=casts,index` | Subset import (`casts`, `users`, `deleted`, `settings`, …) |
| `bun run verify:s3` | Verification-only pass against the bucket |
| `bun run sync:offsite` | Mirror the bucket to a second bucket (postponed; needs `TARGET_S3_*` env) |
| `bun run web:build` | Assemble gitignored `public/` from `static/` — run before web dev/deploy |
| `bun run web:dev` | `wrangler dev` for the web worker |
| `bun run web:deploy` | Deploy the web worker |
| `bun run archiver:deploy` | Deploy the archiver worker (`bun:sqlite` aliased to a build stub) |
| `bun run test` | Hermetic test suite (15 files). Plain `bun test` (no args) ALSO runs a live-API integration test — prefer the script |

Production wiring (server crontab):

```cron
17 * * * *  cd <repo> && ./scripts/cron-set-run-request.sh     # hourly marker
* * * * *   cd <repo> && flock -n logs/doit.lock bun scripts/poll-run-request.ts
```

Wrap manual `bun run doIt` / purge runs in the same `flock` while the poller is active.
Dated logs land in `logs/`.

## Gates

```bash
bun check                          # typecheck (Bun's native checker)
bunx biome check src web scripts   # lint + format — scope it: a repo-wide check
                                   # fails on verbatim backups/*.json payloads
bun run test                       # hermetic tests
```

## Web worker endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | `{ "status": "ok" }` |
| `GET /uptime` | Seconds since isolate start |
| `GET /timeline` | Index-derived timeline; `?spamaway=0` disables the textfilter, `?spam=N` sets the Quilcast threshold (0–100%) |
| `GET /runs/status` | Run progress, proxied to the archiver worker (feeds the landing page's live run section) |
| `GET /status[?fid=]` | Outstanding/completed counts (ETag'd) |
| `GET /api/cast/:hash` | Rendered markdown + filename for a cast |
| `GET /api/archive/stats` | Archive stats incl. casts/month histogram |
| `GET /api/policy` | Public purge policy — `{ "min_age_days", "source" }` |
| `GET /api/hash/:hash/filename` | Resolve a cast hash to its rendered file |
| `POST /doIt` | 202; sets the run-request marker via the archiver binding (502 if unreachable) |
| `GET /browse/**` | The rendered archive; `/browse/<gated-user>/*` is x402-paywalled ($0.01 on Base, `?pay=1`) |
| `GET /llms.txt` | Machine-readable endpoint descriptions (static asset) |

Secrets via `wrangler secret put` (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`X402_API_KEY`); non-secret vars live in `web/wrangler.jsonc`. Deploy with
`bun run web:deploy`.

## Purge loop

See `PLAN.md` for the design and hard invariants. Safety before any delete: the
candidate must be live, not liked by you (likes are the keep mechanism — the like-set
refresh is always full, never incremental: an unlike is the delete signal), not younger
than the public age policy (fid-scoped settings row > global row > `PURGE_MIN_AGE_DAYS`
env > 7 days), and backed up on disk with a passing cryptographic gate. Tombstones are
written before submit; interrupted runs resolve via resume rules on the next run, and
`doIt` self-heals purged casts from `backups/`.

Knobs: `PURGE_MIN_AGE_DAYS`, `PURGE_MAX_BATCH` (50), `PURGE_DELAY_MS` (1000),
`PURGE_RECAST_KEEPS=1` (recasts as keep-signal, default off),
`PURGE_REQUIRE_CHECKPOINT=0` (disables the checkpoint gate).

## Troubleshooting

**Rate limit errors:**
- If you see rate limit errors, your upstream may be throttling requests
- Fetches retry with capped exponential backoff; 400s fail fast (client errors never succeed on retry)

**State issues:**
- There is no cache to clear: `casts/*`, `out/*`, and `meta/index.json` are
  content-addressed/idempotent, and a fresh run re-tags + re-renders (skip-if-rendered
  makes that cheap). There are no delete paths for archived objects.
- Stuck "running" badge on the landing page: the archiver lock takes over after 30
  minutes (crashed-run recovery).

## Development

- Verify with the three gates above.
- The suite is fully hermetic (`MemoryStore` bucket / in-memory SQLite); the only
  live-API file is `src/lib/neynar.integration.test.ts`, excluded from `bun run test`.

### WONTFIX

- [ ] does not show reactions (likes + recasts)
- [ ] does not do all embeds, incl. quote casts
- [ ] no placeholders for frames / miniapps, videos, etc.
