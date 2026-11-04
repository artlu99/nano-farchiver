# PLAN — snapchain purge: delete own unliked casts, keep verified local backups

Model: **live + not liked + not tombstoned = deletable.** Keeps live on the protocol
(likes). Local stores are mirrors or safety artifacts. No hidden timers.

## Hard invariants (violating any = bug)

- [ ] gate passes **from disk** before any CastRemove submit; any error ⇒ fail-closed, no delete
- [ ] tombstone written **before** submit (`deleted_casts`, reason `self-purge (not liked by owner)`)
- [ ] never delete `casts` rows or `out/` files — purged casts remain local forever
- [ ] likes are the only keep mechanism; unlike ⇒ candidate at the very next run
- [ ] age policy is public and enforced: never delete a cast younger than the effective `min_age_days`
      (cast age = now − on-protocol `data.timestamp`); re-checked at delete time, not just selection
- [ ] live run (`--live`) aborts unless `backups/CHECKPOINT.json` covers every candidate **and its
      manifest_sha256 matches the current manifest** (detects backup loss/corruption since the last offsite sync)
- [ ] network errors are never treated as proof of a backup or of deletion
- [ ] `backups/` lives outside `db/` (`bun clean` does `rm -rf db/`); recommend git-tracking it
- [ ] accidental ≠ irreversible: only network presence is unrecoverable; bytes/render/thread survive

## Dropped by design (do not add back)

`keep_casts`, `delete_queue`, `cast_backups`, unlike cooldown, skip state, gRPC client,
separate `restore` command (folded into `doIt` self-heal), `purge:plan` (folded into
`purge:run`'s default dry-run).

## Verified facts (probed 2026-10-14; don't re-derive)

- Gateway `https://snap.farcaster.xyz:3381/v1` (hub-compatible; base already in `src/lib/snapchain.ts`):
  - `GET castsByFid?fid=&pageSize=&pageToken=&reverse=` → `{messages: Message[], nextPageToken}`
  - `GET castById?fid=&hash=` → Message | 404 NotFound
  - `GET reactionsByFid?fid=&reaction_type=Like|Recast` (string enums, not ints)
  - `GET onChainSignersByFid?fid=` → signer events (`SIGNER_EVENT_TYPE_ADD`/`REMOVE`)
  - `POST submitMessage` octet-stream protobuf `Message` — exists, validates proto
- Page cap ≈200 regardless of pageSize (2000→199); end token = empty or base64 `[null,null]`
- Message JSON: `data` = decoded object; `data.timestamp` = s since FARCASTER_EPOCH
  (1609459200000); `hash` 0x-hex; `signature` base64; `signer` 0x-hex; schemes = enum strings
- `@farcaster/core` (already a dep): `MessageData.encode/fromJSON`, `Message.encode`,
  `makeCastRemove(body,{fid,network},signer)`, `makeReactionAdd`, `NobleEd25519Signer`,
  `verifyMessageHashSignature(sig, hash, pub)` (Ed25519), `KEY_REGISTRY_ADDRESS` + `keyRegistryABI`, `Factories`
- `viem` (dep) → KeyRegistry fallback on OP mainnet; alt submitter: Neynar `DELETE /v2/farcaster/cast` w/ `NEYNAR_SIGNER_UUID`
- Signer custody (checked 2026-10-14): FID 3319217 has 2 registered signers (ADD 2026-04-18 `0x6c57…`,
  ADD 2026-04-19 `0xb776…` — the latter signs current casts); **we hold neither private key**;
  no `.env`, no key material in repo. Any registered signer of the FID can remove any of its casts.
  **Decision: BYO signer key as a secret** (`FARCASTER_SIGNER_PRIVATE_KEY`); registration is out of scope.
- Existing churn infra (reuse, don't rebuild): `deleted_casts`, `hasCastInDb` (tombstones count as known → stops
  `paginateFeedResponse`), `filterNonDeletedCastHashes`, `getCastFromHash`→undefined, hydration queries
- Conventions: tabs; `import type`; `noUncheckedIndexedAccess`; test via `mock.module` + `initDb(":memory:")` (see `src/jobs/queue.test.ts`); hashes `normalizeHash`d, queries check both 0x forms

## Tasks

### 1. Foundation
- [ ] signer: **BYO key as a secret** — `FARCASTER_SIGNER_PRIVATE_KEY` (32-byte Ed25519 seed of a
      registered signer, `.env` only; no registration flow in scope). Add a `signer doctor` preflight:
      derive pubkey → assert registered to `ARCHIVER_FID` via `onChainSignersByFid`/KeyRegistry, refuse
      live runs otherwise (dry-run/backup still work without the key)
- [ ] `src/lib/config.ts`: `ARCHIVER_FID` (default 3319217); refactor `src/index.ts` FID + `server.ts` `DEFAULT_FID` onto it
- [ ] policy store: settings rows — bucket objects `settings/<key>.json`
      (`{value, updated_at}`; SQLite twin in the local test bed);
      `config.ts` `getPolicy()` → `{minAgeDays, source}` with precedence
      **fid-scoped settings row > global settings row > `PURGE_MIN_AGE_DAYS` env > 7**
      (pure core in `src/lib/policy.ts`, shared with `web/api.ts`; candidate age =
      now − on-protocol cast timestamp. `setPolicy()` was dropped with the review
      UI — the future archiver HTTP service can resurrect it if it needs a writer)
- [ ] deps: none new needed (sha256 via `node:crypto`; `@noble/hashes` dropped after the gate redesign)
- [ ] `src/lib/snapchain.ts`: add paginated `castsByFid`, `castById`, `reactionsByFid`, `onChainSignersByFid`, `submitMessage`

### 2. Backup + gate
- [ ] `src/lib/backup.ts`: write/read `backups/<hash-no0x>.bin` (serialized MessageData bytes = the hash preimage)
      + `<hash-no0x>.json` (verbatim gateway Message); append-only `manifest.jsonl` line
      `{hash, fid, ts_farcaster, ts_iso, text_preview, data_sha256, signature, signer, verified:{hash,sig,signer_registered}, backed_up_at, file}`;
      `CHECKPOINT.json` `{manifest_sha256, count}` write/verify; disk re-read helpers
- [ ] `src/lib/verify.ts` `gate(hash)` — every step fail-closed, bytes read from disk:
  - [ ] `.bin` + `.json` exist
  - [ ] `MessageData.encode(MessageData.fromJSON(json.data))` == `.bin` bytes (JSON ↔ bytes sync)
  - [ ] Ed25519 `verifyMessageHashSignature(signature, envelope hash, signer)` == true (authenticity — no preimage needed)
  - [ ] `data.fid == ARCHIVER_FID` && network MAINNET && type CAST_ADD
  - [ ] signer registered: latest `onChainSignersByFid` event for key == ADD (fallback viem `keys(fid,key).state == 1`)
  - [ ] `sha256(.bin)` == manifest `data_sha256` (corruption)
  - [ ] informational: text matches local archive row (independent second source)
- [ ] NOTE (found in build): snapchain's canonical serialization ≠ protobufjs re-encoding and the
      gateway is JSON-only ⇒ hash cannot be re-derived from data locally; the data↔hash binding is
      inherited from the HTTPS gateway + second-source cross-check. Hardening path: raw `data_bytes`
      via snapchain gRPC :3383. Fixture hashes DID verify via `blake3(bytes, {dkLen: 20})` (hub `blake3_20`)
- [ ] package.json scripts: `backup:all` (backup + verify-from-disk in one pass) | `backup:verify [--sample N]`
      (periodic bit-rot drill) | `backup:checkpoint` (performs the offsite sync itself — git commit+push or rsync —
      **then** writes `CHECKPOINT.json`) | `purge:run [--live [N]]` → `bun src/jobs/purge.ts <sub>`;
      `bundle` tar includes `backups/` (every bundle = offsite-able snapshot); `clean` → `bun scripts/clean.ts`

### 3. Purge loop (`src/jobs/purge.ts`)
- [ ] like-set refresh (every command, **full pagination — never incremental**; unlikes are the delete signal):
      upsert seen / delete vanished in `self_reactions(target_hash, type DEFAULT 'like', updated_at, PK(target_hash,type))` — disposable mirror
- [ ] preflight: every live cast has a `casts` row, else abort + drift report (`candidates ⊆ live ⊆ casts ⊆ backups`); live runs also run `signer doctor` + **auto-checkpoint** (offsite sync + CHECKPOINT.json; abort if sync fails — no manual step)
- [ ] resume rules at startup: **finish** tombstoned+live+unliked ⇒ re-submit (CastRemove idempotent); **release** tombstoned+live+liked ⇒ remove tombstone (protocol wins); **settled** tombstoned+absent ⇒ no-op
- [ ] candidates = live − likeSet (− recastSet if `PURGE_RECAST_KEEPS`) − tombstoned, age ≥ `getPolicy().minAgeDays`
- [ ] per candidate (oldest first, cap `PURGE_MAX_BATCH`, `N` if `--live N`):
  - [ ] `castById`: 404 ⇒ `markCastsDeleted("not found upstream")`, done; transport error ⇒ FAIL
  - [ ] gate from disk; no valid backup ⇒ back up + gate now, abort on failure
  - [ ] default dry-run: log "would delete" table, exit 0 (`--live [N]` to actually delete)
  - [ ] age re-check vs **current** policy ⇒ skip if too young (mid-run policy changes apply immediately)
  - [ ] fresh `reactionsByTarget` re-check: like appeared ⇒ skip, no tombstone
  - [ ] INSERT tombstone → `makeCastRemove({targetHash}, {fid, network: MAINNET}, new NobleEd25519Signer(key))` → `Message.encode` → POST submitMessage
  - [ ] confirm `castById` 404 (≤3 polls; else next run's finish rule settles)
  - [ ] sleep `PURGE_DELAY_MS`
- [ ] errors: `bad_request.*` = permanent-for-this-run (log, skip); transport = retry (`retryWithSkip` pattern); no failed state — candidate just retries next run

### 4. Churn fixes + self-healing archive
- [ ] `tagCast` (`src/jobs/read.ts`): skip INSERT when hash ∈ `deleted_casts` (blocks zombie resurrection via stale conversations; existing rows untouched)
- [ ] `castsLoop` (`src/jobs/write.ts`): skip tombstoned hashes unless `out/` file already exists; never rewrite a purged file
- [ ] self-heal in `doIt` (always-on, no modes to remember): after network fetch, for every `backups/` manifest
      entry with `fid == ARCHIVER_FID` missing from `casts` — INSERT row (ON CONFLICT DO NOTHING) + re-render via
      the normal writeLoop; entries absent from the live set also get tombstoned (`restored from backup`;
      backup exists + network-gone ⇒ was deleted ⇒ tombstone correct + churn-safe). Makes `bun clean`
      non-destructive: the next `bun doIt` reconstitutes purged casts
- [ ] clean guard: replace the `rm -rf` one-liner with `bun scripts/clean.ts` — refuses (exit 1) when it would
      destroy `out/` renders of manifest-backed casts, prints the `--force` escape hatch

### 5. Review UI (fail-closed)
- [ ] every `/review*` endpoint requires `REVIEW_TOKEN` (constant-time compare); unset ⇒ 404; never x402-gated, absent from `/llms.txt`
- [ ] `react/review.html` + `react/review.tsx` (daisyui), mounted in `serve.ts`
- [ ] `GET /review/candidates` (server-paged 50): preview, date, age, gate badge (`unverified`/`verified ✓`), liked ✓ / unliked—eligible
- [ ] `GET /api/policy` — **public, no token**: `{min_age_days, source, updated_at}`; also merged into `/api/archive/stats` + `/llms.txt`
- [ ] review UI shows current policy inline; `POST /review/policy {min_age_days}` (token-gated) writes the settings row
- [ ] `GET /review/deleted`: tombstones × backup status (= purge ledger)
- [ ] `POST /review/like/:hash` ⇒ `makeReactionAdd({type: LIKE, targetCastId:{fid,hash}})` via submitMessage (keep lands on protocol)
- [ ] `POST /review/delete/:hash` ⇒ server re-runs full gate regardless of UI state
- [ ] `POST /review/verify-all`; `POST /review/purge` (honors `PURGE_MAX_BATCH`; deletes only in live mode)

### 6. Archive viz (rolled into `/browse` index; server-rendered, daisyui, no chart lib; load dataviz skill first)
- [ ] stat row: archived · live · purged · backed-up+verified (manifest count, TTL cache) · deletable · min-age policy · users
- [ ] casts/month histogram via `json_extract(data,'$.timestamp')`, CSS bars
- [ ] purge-progress bar: purged / kept(liked) / deletable
- [ ] purge ledger: recent self-purge tombstones → link local rendered file + backup badge — **red alert** if a purged cast's backup is missing/corrupt (`backup:verify` reports these as failures)
- [ ] `GET /api/archive/stats` (JSON) + list in `/llms.txt`

### 7. Tests (`bun test`, hermetic)
- [ ] gate: passes on genuinely signed fixtures (built via `makeCastAdd` + `NobleEd25519Signer`); fails on flipped `.bin` byte / corrupted sig / missing `.bin` / sha256 mismatch
- [ ] loop: liked ⇒ not candidate; unlike ⇒ candidate next run; tombstone-before-submit (spy order); default dry-run never submits; resume rules ×3; second run no-op; min-age policy; preflight drift abort; mid-run like aborts via re-check; live run auto-checkpoints (sync failure ⇒ abort) and refuses on checkpoint/manifest mismatch; refresh deletes vanished targets
- [ ] policy: settings-row > env > default precedence; boundary (N−1 days ⇒ not candidate, N+1 ⇒ eligible); lowering mid-run blocks an already-selected young delete; `GET /api/policy` public and reflects override
- [ ] churn: after purge, `tagCasts(stale conversation containing purged)` doesn't insert; `castsLoop` skips; `hasCastInDb` true
- [ ] resilience: self-heal re-inserts + re-renders manifest entries post-clean and tombstones absent-from-live ones (live ones just re-inserted); `fid != ARCHIVER_FID` entries ignored; clean guard refuses without `--force`; checkpoint manifest-sha mismatch refuses live runs

### 8. Run (ordered)
- [ ] `bun install` → `bun run backup:all` (backup + verify-from-disk in one pass)
- [ ] `bun run purge:run` — dry-run default: prints candidates + gate results, deletes nothing
- [ ] optional: `bun start` → `/review` — per-cast keep(=Like)/delete
- [ ] `bun run purge:run --live 10` — auto-checkpoints (offsite sync + CHECKPOINT.json) first; grow `N` per batch
- [ ] `bun clear && bun doIt` — normal archiver run; confirm via its logs + `/browse` stats (no tombstone re-fetch, pagination stops page 1, outstanding stable, `out/` unchanged)

## Env

`ARCHIVER_FID`=3319217 · `FARCASTER_SIGNER_PRIVATE_KEY` (BYO secret — 32-byte seed of a registered signer; live runs verify registration, dry-run/backup need no key) · `PURGE_MIN_AGE_DAYS`=7 (env fallback; runtime value = `settings` row override, publicly read via `GET /api/policy`) · `PURGE_MAX_BATCH`=50 (`--live N` overrides per run) · `PURGE_DELAY_MS`=1000 · `PURGE_RECAST_KEEPS`=0 · `PURGE_REQUIRE_CHECKPOINT`=1 (0 = consciously accept single-copy risk; auto-checkpoint still runs, just doesn't gate) · `REVIEW_TOKEN` (unset ⇒ /review* disabled)
