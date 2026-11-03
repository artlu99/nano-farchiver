# MIGRATION — one VPS app → two standalone services over one S3-compatible bucket

Status: plan (not started). Replaces the earlier Workers+Workflows design
(intentionally simpler: no Durable Objects, no Queues, no Cloudflare-specific
storage). Read alongside `PLAN.md` — the purge invariants still apply.

## 1. Requirements

- **R1 — Two standalone pieces**, independently deployable, communicating over
  **unauthenticated REST**:
  1. **`web`** — public single-FID service: browse/timeline/cast pages + the x402
     paywall. **Read-only** against the bucket (read-only credentials; it cannot
     write even by accident).
  2. **`archiver`** — read-write **multi-FID** service: fetches feeds and **writes
     incrementally** to the bucket. Owns the review/purge surface (writes) and the
     fid registry.
- **R2 — Provider-agnostic S3.** All bucket access goes through the S3 REST API
  (`aws4fetch`). **No R2 bindings, no D1, no KV, no Durable Objects, no
  Workers-specific APIs in the data path** — must run unchanged against R2, AWS S3,
  Tigris, Backblaze B2, and Garage.
- **R3 — Incremental updates** (archiver): pagination short-circuit, idempotent
  tagging, skip-if-rendered — plus run continuation so a first fetch of a new FID
  (or a deep refresh) makes bounded progress per tick instead of one long job.
- Bun stays the dev/test toolchain. Both pieces are plain `fetch`-handler services:
  `web` ships as a Worker (needs Static Assets for the UI), `archiver` ships as a
  Worker (cron trigger) or a plain Bun process — identical code.

## 2. Topology

```
                    cron (*/15) ──► archiver: incremental run, all active fids
Browser ──► web (Worker + Static Assets)          archiver (Worker cron or Bun)
              │  reads bucket (read-only creds)     │  writes bucket (rw creds)
              │  GET /browse /timeline /api/*       │  PUT casts/, users/, out/, meta/
              │  x402 gate (1 username)             │  /review/* purge ops (token-gated)
              └── POST /runs, GET /status ────────► │  (unauthenticated REST)
```

There is no other coupling: the bucket is the contract. `web` never calls `archiver`
except the two endpoints above (trigger a run; read progress). `archiver` never
calls `web`.

## 3. The bucket (shared contract)

```
casts/<hash-no0x>.json        users/<fid>.json         deleted/<hash-no0x>.json
settings/<key>.json           reactions/<fid>/<target>#<type>.json
fids/<fid>.json               config/textfilters.jsonl
out/<username>/<file>.md      backups/…                meta/index.json   meta/cursor/<fid>.json
```

- Hash keys are normalized (`normalizeHash`, 0x-form) at write time — the old
  double-form lookups disappear from hot paths.
- **Key identity (deliberate): `casts/`, `deleted/`, `backups/` are keyed by
  cast hash alone — hash = global message identity, so a different (or newly
  added) fid can only append, never overwrite.** The corpus is cross-author by
  design (conversation participants), so fid-scoping those keys would duplicate
  shared casts/renders without adding isolation. fid lives where it is part of
  the fact: every index tuple and manifest row carries `fid`; reactions,
  cursors, the fid registry, and policy keys are fid-scoped. Overwrite control
  is the single-writer rule (§9), not key names; strong per-fid isolation, if
  ever wanted, is a bucket (or prefix + scoped creds) per fid — no code change.
- **`meta/index.json`** is the read index that replaces SQLite queries (joins,
  anti-joins, counts, timeline sort). One compact object:
  `{version, updatedAt, casts:{hash:[fid,ts,parentHash,parentFid,replyCount,preview]},
    deleted:{hash:[reason,deletedAt]}, quotes:{}, users:{}, fids:{}, rendered:{}}`
  (~1 MB at 7k casts; ~10 MB at 10 FIDs — shard by owning-fid past ~20 MB).
  `web` caches it per isolate with ETag revalidation; timeline/stats/listing/status
  become in-memory computations over it.
- **Truth vs cache**: `casts/*`, `deleted/*`, … objects are truth; the index is a
  rebuildable cache maintained by `archiver` after writing truth. A reader that
  lags one commit is fine.
- `meta/cursor/<fid>.json` — continuation cursor when a run exhausts its budget
  mid-fetch (see §5).

### 3.1 Provider portability rules

- Only S3 REST verbs: `Get/Put/Delete/ListObjectsV2` (+ conditional PUTs where
  available). `marked`, sha256, ed25519, protobuf are pure JS — portable everywhere.
- **Consistency strategy is single-writer, not provider features.** Only `archiver`
  writes, one run at a time (single deployment instance + in-process lock; the
  `lock/run` object is advisory). Conditional PUT (`If-Match`) is used for index
  commits where the provider supports it (R2, AWS) and degrades to
  check-then-put-and-log elsewhere (Tigris/B2/Garage) — safe *because* there is
  exactly one writer process.
- Directory listings (`/browse` pages) use `ListObjectsV2` with `Delimiter=/`
  (universally supported), not provider-specific feeds.

## 4. Piece 1 — `web` (single-FID, public, read-only)

### 4.1 Routes (subset of today's `server.ts`/`serve.ts`)

| Route | Backing |
|---|---|
| `/`, `/static/*`, `/llms.txt`, `/react/*` | Static Assets (`static/` + built `react/`, tailwind built pre-deploy) |
| `/browse/*` | index + `ListObjectsV2` for listings; object GET + `marked` for files; **x402 gate on the one username** (`X402_USERNAME`), preview/free logic unchanged |
| `/timeline` | index (sorted by ts, tombstone-filtered, textfilters from `config/textfilters.jsonl`, previews from index — no per-row GETs) |
| `/api/cast/:hash` | index lookup → `casts/<hash>.json` GET |
| `/status`, `/api/archive/stats`, `/api/policy` | index + `settings/` objects (same response shapes/ETags as today) |
| `/health`, `/uptime` | unchanged |
| `POST /doIt` | **proxied**: `POST {ARCHIVER_URL}/runs` (202/429 mapping preserved) |
| ~~`/review*`~~, ~~`POST /clear`~~ | moved to `archiver` / dropped (writes are not possible with read-only creds — enforced, not just conventional) |

`PUBLIC_APP_URL` rewriting becomes an identity no-op on Workers (kept for dev).

### 4.2 Caching (why per-request S3 reads are acceptable)

Per-request reads cost ~50–150 ms TTFB in-region (distance-dominated, not sigv4;
provider-agnostic S3 API ≈ native binding within a few ms). Two cache layers bring
public pages back to static-asset speed:

- **Isolate index cache**: `meta/index.json` cached per isolate, revalidated by
  ETag — steady state pays no index GET.
- **Edge cache** (Cache API, TTL ≤ 5 min) on public, identical-for-everyone
  responses: `/browse` HTML, `/timeline`, `/api/cast/:hash`, `/api/archive/stats`,
  `/static/*`. First visitor per region pays the R2 round trip; the rest are colo
  hits. Freshness ≤ 5 min vs incremental runs every ~15 min — acceptable.
- **Never cached**: x402-gated/preview paths, `/status` (private ETag semantics),
  `/health`, `/uptime`.
- Static Assets hold only deploy-time content (UI, styles, `llms.txt`) — archive
  content changes every tick and must not be baked into deploys.

### 4.3 Config

`ARCHIVER_FID`, `ARCHIVER_USERNAME` (primary), `X402_USERNAME` (default = primary),
`X402_API_KEY` (secret), `X402_ALLOWLIST`, `X402_MAX_TIMEOUT_SECONDS`,
`REVIEW_TOKEN` — **not needed** (no review surface here), `S3_ENDPOINT`,
`S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (**read-only**
credentials — on R2: an API token scoped read-only to the bucket), `ARCHIVER_URL`
(piece 2 base URL for `/doIt` proxying).

Deps drop to: `hono`, `marked`, `@x402/*`, `aws4fetch` (+ tiny-invariant/radash).
No `@farcaster/core`, no Neynar client, no `viem` beyond x402's — small bundle.

## 5. Piece 2 — `archiver` (multi-FID, read-write, incremental)

### 5.1 The incremental run (per cron tick or `POST /runs`)

Bounded work per invocation; if the budget runs out, progress is persisted and the
next tick resumes — this is what makes both multi-FID onboarding (a new fid's first
fetch is up to 10k casts) and deep refreshes safe without any job orchestration
product:

1. **Claim run** — in-process lock (single instance); advisory `lock/run` object
   with expiry for observability. Busy → `409` (HTTP trigger) / skip (cron).
2. **Per active fid** (from `fids/*.json`, staggered):
   - `fetchFeeds` — existing `paginateFeedResponse` with the `hasCastInDb`
     short-circuit against the index (steady state: 1–3 pages). Budget: N pages.
   - **Continue or start**: if `meta/cursor/<fid>.json` exists, resume from it
     (cursor mode ignores the short-circuit until caught up); delete the cursor
     when the feed is exhausted.
   - `tagNew` — put `casts/<hash>.json` + `users/<fid>.json` (idempotent,
     hash-addressed = `INSERT OR IGNORE` semantics) for casts not in the index.
   - `hydrate` — conversations + `traverse` for new casts only, bounded per tick
     (chunked; within-run dedup via in-memory Maps = today's `cache.db3` role;
     absent-by-upstream → tombstone object, as today).
   - `render` — for queued casts: render markdown, `PUT out/…` only when the
     index `rendered` entry differs (embeds fingerprint, replyCount, `<deleted>`
     marker). Budget: M files per tick; remainder stays queued in the index.
   - `commit` — write `meta/cursor/<fid>.json` if unfinished; commit
     `meta/index.json` (update `casts`/`rendered`/`updatedAt`, replyCounts,
     lastRunAt per fid).
3. **Release lock.**

Self-heal from `backups/` stays a step in the run, parameterized per fid
(manifest entries carry `fid` already).

### 5.2 Routes

| Route | Notes |
|---|---|
| `POST /runs` (alias `POST /doIt`) | **unauthenticated**, per R1 — triggers an incremental run; 202 / 409-busy. Safe to expose: runs are bounded, idempotent, read-mostly |
| `GET /status` | **unauthenticated** — per-fid `{outstanding, completed, lastRunAt, running}` (consumed by `web`) |
| `GET /fids` | unauthenticated — active registry |
| `/review/*` + review UI (`react/review.html`) | token-gated exactly as today (`REVIEW_TOKEN`, fail-closed): candidates, deleted ledger, like/delete, verify-all, policy. Purge invariants unchanged; gate reads backup objects from the bucket instead of disk |
| `/health` | unchanged |

### 5.3 Multi-FID specifics

- `fids/<fid>.json` registry = source of truth; `ARCHIVER_FIDS` env is the seed.
  Adding a fid = write the object (+ its signer secret if purge is wanted) → next
  tick fetches from page 1 with cursor continuation. No redeploy.
- Purge: per-fid signer resolution (`FARCASTER_SIGNER_PRIVATE_KEY__<FID>`), per-fid
  like-set (`reactions/<fid>/…`), per-fid policy key `purge_min_age_days:<fid>`
  (precedence: fid > global > env > 7d), per-fid preflight. Missing signer degrades
  exactly as today (dry-run/backup work, live refuses).
- x402: not part of `archiver` (piece 1's concern).
- **Purge/backup CLI stays on Bun** (`src/jobs/purge.ts` subcommands) against the
  same bucket via the shared store — no need to HTTP-ify it now. Offsite sync
  (`Bun.$` git/rsync) becomes: bucket versioning ON + periodic copy to a second
  bucket (CLI or cron); `CHECKPOINT.json` gate logic unchanged (sha256 of
  `manifest.jsonl` bytes).

### 5.4 Config

`ARCHIVER_FIDS` (seed), `S3_*` (**read-write** credentials),
`REVIEW_TOKEN` (secret), `FARCASTER_SIGNER_PRIVATE_KEY__<FID>` (secrets),
`PURGE_*` knobs (same meanings), `RUN_BUDGET` (pages/casts/renders per tick).

## 6. REST contract between the pieces (unauthenticated, per R1)

```
POST {ARCHIVER_URL}/runs          → 202 {started:true} | 409 {started:false,reason:"busy"}
GET  {ARCHIVER_URL}/status        → 200 {fids:{fid:{outstanding,completed,lastRunAt,running}}}
```

No auth, no signatures. Rationale: both endpoints are read-only in effect (a run is
bounded/idempotent; status is a read). `web` calls them server-side only (never
exposes `ARCHIVER_URL` to the browser). If a private deployment ever needs it, a
shared-token header is a two-line addition — deliberately out of scope now.

## 7. Code organization

```
src/
  store/types.ts      # ArchiveStore: get/put/putIfMatch/list/delete/index
  store/s3.ts         # aws4fetch impl (endpoint+creds from env) — the ONLY bucket client
  store/memory.ts     # in-memory impl for bun test
  store/indexModel.ts # key builders, index shape, load/commit (If-Match RMW), listAllKeys
  store/store.test.ts # hermetic store + index tests
  ctx.ts              # RunContext (missingCastHashes, userCache — kills module globals)
  jobs/               # read.ts / write.ts / purge.ts — logic kept, store-backed
  lib/                # neynar, snapchain, backup, verify, markdown, helpers, …
apps/
  web/       index.ts (fetch handler + assets), wrangler.jsonc
  archiver/  index.ts (fetch handler + tick()), wrangler.jsonc  [or bun run apps/archiver]
scripts/
  import-to-s3.ts    # one-time: SQLite + out/ + backups/ → bucket (idempotent, --dry-run)
  manage-fids.ts     # add/remove fid (writes fids/<fid>.json)
```

Refactor inventory (mechanical, unchanged logic): every `bun:sqlite`/`node:fs` call
site → store; module-global state (`src/jobs/read.ts:13,66`, `src/jobs/purge.ts:583`,
`src/lib/stats.ts:20`) → `RunContext`/request state; `Bun.sleep` → plain
`await new Promise(setTimeout)`; `Bun.$` syncOffsite → §5.3; `server.ts` split along
the §4.1 / §5.2 tables. `thirdweb` is unused (verified) — dropped.

## 8. Stages

Progress (2026-11-03):

- [x] Provider decision: **R2 primary (read-write)**; portability to AWS S3 /
      Tigris / B2 / Garage preserved by the S3-API store, verified by the
      conditional-PUT probe in the import verify step.
- [x] Design note: quotes live only in the index (derived from cast objects) —
      no `quotes/` prefix; the index stays rebuildable from `casts/*` truth.
- [x] `src/store/` (types, s3, memory, indexModel) + hermetic tests; `bun test`,
      `bunx tsc`, `bunx biome check` green.
- [x] `scripts/import-to-s3.ts` (dry-run validated: 6,495 objects from this
      machine's data — 2,631 casts, 3,102 renders, 471 users, 53 backups,
      36 tombstones, 199 reactions).
- [x] **Jobs refactor onto `RunContext`**: `src/data/{types,sqlite,store}.ts`
      + `src/ctx.ts`; `jobs/read.ts` + `jobs/write.ts` + `markdown.ts` +
      `neynar.ts` now data-layer-backed (default = SQLite, byte-identical
      behavior; `createStoreRunContext` exercises the bucket path — tested in
      `src/data/store.test.ts`). Index tuple carries `parent_fid` (countReplies
      matching). `cache.db3` → in-memory run cache (`bun clear` is now a
      no-op kept for habit). Module globals (`missingCastHashes`,
      `userCache`, neynar caches) are context-scoped.
- [x] **Purge/heal/render port**: `RenderSink` (`src/sink.ts` — fs or bucket
      objects) backs castsLoop/fidsLoop/self-heal renders; purge internals
      (like-set mirror, resume rules incl. `unmarkDeleted` release, drift
      preflight, deleted ledger, `restoreTombstonedCast` heal insert) and
      settings/policy are data-layer ops on both backends; `getPolicy` is
      async per-fid-capable (`getPolicySync` is the transitional stats path);
      the gate's second-source text check reads via the data layer.
      Still fs/sqlite (port with the archiver service deploy): `backups/`
      artifacts + offsite checkpoint (§5.3 stays Bun), `stats.ts`/`timeline`
      read paths (web tier, stage 4).
- [x] **Backend flip switch**: `ARCHIVE_BACKEND=store bun run doIt` runs the
      whole pipeline (fetch → tag → heal → render) against the bucket; unset
      keeps SQLite + local `out/`. This is the stage-3 single-writer switch.
- [ ] **Next:** create the R2 bucket + read-write token, set `S3_*` env, run the
      real import (`bun run import:s3`), then `bun run verify:s3`; stand up the
      read-only `web` piece against the bucket (stages 3–4).

1. **Store + refactor (Bun-only, no behavior change).** `ArchiveStore` +
   `MemoryStore` + `S3Store`; `RunContext`; fid parameterization
   (`getPolicy(fid)`, purge/self-heal per fid, `reactions/<fid>/`). All existing
   tests pass against `MemoryStore`. *(Store layer + import script are done;
   the `RunContext`/fid refactor of `src/jobs` remains.)*
2. **Import.** `scripts/import-to-s3.ts`: SQLite rows → objects + index; `out/`
   byte-identical paths; `backups/`; textfilters. Versioning ON from day one.
   VPS keeps running off local SQLite (no shared state yet).
3. **`archiver` live.** Deploy piece 2 (Bun process first — easiest to debug;
   Worker+cron when stable). **Single-writer flips here** (disable VPS `doIt`).
   Soak: compare index vs SQLite; run the purge CLI dry against the bucket.
4. **`web` live on staging.** Parity-diff `/browse`, `/timeline`, `/status`,
   `/api/*` vs VPS (HTML structural + JSON deep-equal); x402 verify/settle on the
   real facilitator against staging.
5. **Cutover.** DNS → `web`; decommission VPS (or keep as cold fallback running
   `archiver` code against the bucket).
6. **Cleanup.** Delete `serve.ts`/SQLite paths (or `legacy/`); docs; CI gates:
   `bunx tsc`, `bunx biome check`, `bun test`, `wrangler deploy --dry-run`.

Rollback before stage 5 = DNS still on VPS + re-enable its writer (VPS SQLite was
never touched after stage 3's import). Rollback after = re-point DNS; bucket is
additive.

## 9. Testing

- `bun test` hermetic on `MemoryStore` (direct successor of the
  `initDb(":memory:")` + `mock.module` pattern); existing fixtures stay.
- Contract tests for the two REST endpoints (fetch-handler level, no host needed).
- Store integration smoke against a real provider dev bucket (R2 first; one run
  each against Tigris/B2/Garage before calling portability done — conditional-PUT
  fallback is the thing to verify).
- Parity harness (stages 3–4): replay routes against old/new and diff.

## 10. Risks / open questions

1. **Check-then-put index commits on providers without conditional writes** — safe
   only under the single-writer rule; if a second writer ever appears (HA), this
   becomes the first thing to fix (provider with conditional PUT, or shard the
   index per writer).
2. **Run budget sizing** — pages/casts/renders per tick must keep a tick under the
   Worker CPU/wall limits; Bun deployment has no such constraint (another reason to
   stage piece 2 on Bun first).
3. **`traverse` unboundedness** on big threads (`MAX_SIZE` 1000) — bounded per tick
   by the hydrate budget; frontier continuation is carried in the cursor object if
   ever needed (start without it).
4. **Timeline lag** — index may lag truth by one commit; acceptable (`/api/cast/:hash`
   reads truth). `preview` in the index keeps timeline free of object GETs.
5. **Fid registry writes are admin ops** — `manage-fids.ts` (CLI) first; an
   authenticated `POST /fids/:fid` is a later addition (deliberately not part of
   the unauthenticated surface).
6. **Which provider is primary?** R2 assumed for cost/egress; the import script and
   smoke tests make switching a re-run of stage 2 against new `S3_*` env.
