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

Run the archiver:
```bash
bun doIt
```

Bundle the outputs into a gzipped tarball:
```bash
bun run bundle
```

(Optional) Clean up:
```bash
bun clean  # Removes out/ and out.tar.gz
bun clear  # Removes db/queue.db3
```

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
