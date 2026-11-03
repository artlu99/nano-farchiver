# nano-farchiver

**[Farchiver](https://farchiver.xyz)** uses direct access to the network, and can never be blocked due to modularity, and ability to re-route to multiple data sources.

 However, it is quite expensive to run that way.

`nano farchiver` is a weekend project that leverages free + paid SAAS. It may be censorable, but it costs very little.

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Configure the FID to archive:**
   Edit `src/index.ts` and set the `FID` constant to the Farcaster ID you want to archive.

## Running

### CLI

Run the archiver:
```bash
bun doIt
```

Bundle the outputs into a gzipped tarball:
```bash
bun bundle
```

### Incremental updates

After an initial run, subsequent runs automatically detect and fetch only new casts by checking against the local queue (`db/queue.db3`). To prepare for an incremental run:

```bash
bun clear  # Clear the network cache so fresh data is fetched
bun doIt   # Fetches only new casts, skips already-written output files
```

To archive the output and start fresh for the same FID:
```bash
bun bundle    # Create out.tar.gz
bun clear     # Clear the network cache
bun doIt      # Incremental run
```

To switch to a different FID:
```bash
bun clean  # Removes all databases and output — clean slate
bun doIt   # Full fetch for the new FID
```

### Purge loop (delete unliked casts, keep verified backups)

See `PLAN.md` for the full design. Commands:

```bash
bun run backup:all           # raw backup + verify of all live casts (no deletes)
bun run backup:verify        # re-verify backups from disk (bit-rot drill)
bun run backup:checkpoint    # offsite sync (git push / rsync) + CHECKPOINT.json
bun run purge:run            # dry-run default: lists candidates + gate results, deletes nothing
bun run purge:run --live 10  # live: auto-checkpoints first, deletes up to N candidates
```

Safety: a candidate must be live, not liked by you (likes are the keep
mechanism), not younger than the public age policy (`GET /api/policy`), and
backed up on disk with a passing cryptographic gate before any delete.
Tombstones are written before submit; `bun clean` is guarded and the next
`bun doIt` self-heals purged casts from `backups/`.

### Web server

```bash
bun start   # builds `react/tailwind.css`, then serves (default port 3000)
bun dev     # same, with `--hot` reload on `serve.ts`
```

`react/tailwind.css` is generated (gitignored). `postinstall`, `start`, and `dev` run `tailwind:build` automatically; use `bun run tailwind:watch` in another terminal while editing styles.

Starts a web server (configurable via `PORT`) with the following endpoints:

| Endpoint | Description |
|---|---|
| `GET /health` | Health check — `{ "status": "ok" }` |
| `GET /uptime` | Seconds since server started |
| `GET /status` | Aggregate outstanding/completed cast counts |
| `GET /status?fid=<number>` | Per-user outstanding/completed counts |
| `POST /doIt` | Trigger the archiver job (202 if started, 429 if already running) |
| `POST /clear` | Clear the network cache so the next `/doIt` fetches fresh data |
| `GET /browse/**` | Browse the `out/` directory — lists folders, renders `.md` files as HTML |
| `GET /api/policy` | Public purge policy — `{ "min_age_days", "source" }` |
| `GET /api/archive/stats` | Public archive stats (counts + casts/month histogram data) |
| `GET /review*` | Purge review UI/API — token-gated (404 unless `REVIEW_TOKEN` set) |
| `GET /llms.txt` | Machine-readable endpoint descriptions |

Related env vars for the server: `X402_FACILITATOR_URL`, `X402_API_KEY`, `X402_ALLOWLIST`, `PUBLIC_APP_URL` (see `server.ts`).

## Troubleshooting

**Rate limit errors:**
- If you see rate limit errors, your upstream may be throttling requests
- For production use: consider using a higher-throughput upstream or adding rate limiting

**Cache / state issues:**
- `bun clear` — removes the network cache (`db/cache.db3`) so the next run fetches fresh data from the API
- `bun clean` — removes all databases and output for a completely fresh start

## Development

Archiver (fetch casts to `out/`):

```bash
bun doIt
```

React UI + API (`/react/`, `/api/cast/:hash`):

```bash
bun dev
```

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

### WONTFIX

- [ ] does not show reactions (likes + recasts)
- [ ] does not do all embeds, incl. quote casts
- [ ] no placeholders for frames / miniapps, videos, etc.
