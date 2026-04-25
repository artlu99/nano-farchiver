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

### Web server

```bash
bun server.ts
```

Starts a web server (default port 3000, configurable via `PORT` env var) with the following endpoints:

| Endpoint | Description |
|---|---|
| `GET /health` | Health check — `{ "status": "ok" }` |
| `GET /uptime` | Seconds since server started |
| `GET /status` | Aggregate outstanding/completed cast counts |
| `GET /status?fid=<number>` | Per-user outstanding/completed counts |
| `POST /doIt` | Trigger the archiver job (202 if started, 429 if already running) |
| `POST /clear` | Clear the network cache so the next `/doIt` fetches fresh data |
| `GET /browse/**` | Browse the `out/` directory — lists folders, renders `.md` files as HTML |
| `GET /llms.txt` | Machine-readable endpoint descriptions |

## Troubleshooting

**Rate limit errors:**
- If you see rate limit errors, your upstream may be throttling requests
- For production use: consider using a higher-throughput upstream or adding rate limiting

**Cache / state issues:**
- `bun clear` — removes the network cache (`db/cache.db3`) so the next run fetches fresh data from the API
- `bun clean` — removes all databases and output for a completely fresh start

## Development

To run in development mode:
```bash
bun run src/index.ts
```

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

### WONTFIX

- [ ] does not show reactions (likes + recasts)
- [ ] does not do all embeds, incl. quote casts
- [ ] no placeholders for frames / miniapps, videos, etc.
