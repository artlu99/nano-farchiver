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

(Optional) Clean up:
```bash
bun clean  # Removes out/ and out.tar.gz
bun clear  # Removes db/queue.db3
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
| `GET /browse/**` | Browse the `out/` directory — lists folders, renders `.md` files as HTML |
| `GET /llms.txt` | Machine-readable endpoint descriptions |

## Troubleshooting

**Rate limit errors:**
- If you see rate limit errors, your upstream may be throttling requests
- For debugging: The built-in caching system (`db/cache.db3`) helps avoid redundant API calls
- For production use: consider using a higher-throughput upstream or adding rate limiting

**Cache / state issues:**
- Clear the cache with: `bun clear` (removes `db/queue.db3`)
- Note: This doesn't clear the main cache database `db/cache.db3`

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
