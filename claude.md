# Codebase Context for LLM Agents

This document provides technical context for AI coding agents working with the `nano-farchiver` codebase.

## Architecture Overview

`nano-farchiver` is a Farcaster archiver that uses Neynar's API to fetch and archive casts, replies, and conversations. The project uses a job queue system with SQLite caching to minimize API calls.

## Key Components

### Entry Point
- **`src/index.ts`**: Main entry point
  - Sets the `FID` constant (Farcaster ID to archive)
  - Calls `getCronFeed()` and `getReplies()` to fetch initial data
  - Queues casts for processing via `queueLoop()`
  - Starts the write loop via `writeLoop()`

### API Client
- **`src/lib/neynar.ts`**: Neynar API client with caching
  - Uses `itty-fetcher` for HTTP requests
  - Implements SQLite caching (`db/cache.db3`) to avoid redundant API calls
  - Two API clients are configured:
    - `api`: Standard Neynar API client using `NEYNAR_API_KEY`
    - `x402api`: x402 payment-enabled client (configured but not currently used)
  - Functions:
    - `getCronFeed(fid)`: Fetches user's casts (limit 150, no replies)
    - `getReplies(fid)`: Fetches user's replies (limit 50)
    - `getConversation(hash)`: Fetches conversation thread for a cast
    - `getCasts(hashes[])`: Batch fetches up to 25 casts by hash

### Job Processing
- **`src/jobs/read.ts`**: Reading/processing job queue
  - Processes casts from the queue
  - Fetches conversations and related casts
  - Tags and stores cast data
  
- **`src/jobs/write.ts`**: Writing/archiving job queue
  - Writes processed casts to output files
  - Handles file system operations

### Data Storage
- **`db/cache.db3`**: SQLite database for API response caching
  - Tables: `casts`, `replies`, `conversations`
  - Prevents redundant API calls on re-runs
- **`db/queue.db3`**: SQLite database for job queue (created by job processing)

## Environment Variables

The code requires these environment variables (checked via `invariant`):
- `NEYNAR_API_KEY`: Required for Neynar API access
- `EOA_PRIVATE_KEY`: Required for x402 payment system (even if not actively using x402)

## x402 Implementation Status

The x402 payment system is **partially implemented**:
- `x402api` client is configured in `src/lib/neynar.ts` (lines 39-45)
- Uses `x402-fetch` package to wrap fetch with payment functionality
- Currently **not actively used** - all API calls use the standard `api` client
- To enable x402: switch from `api` to `x402api` in the function implementations

## Rate Limiting

The codebase currently does not implement rate limiting logic. Rate limit handling is external and solved through configuration/payment options.

**Current rate limit solutions (see README.md for details):**
1. **Neynar Subscription ($9/month)**: Avoids all rate limits
2. **x402 Payment System**: Pay-per-request access (requires enabling x402api in code)
3. **Paid Farchiver Customer**: 0.0069 ETH for direct network access

**Current design:**
- Relies on external rate limits from Neynar API
- Uses caching (`db/cache.db3`) to reduce redundant API calls

**Debugging rate limit issues:**
- Free tier API keys are limited to ~6 queries/second
- Rate limit errors indicate you've hit the API's rate limit
- Caching helps reduce redundant calls on subsequent runs

**If implementing custom rate limiting:**
- API calls are made in `src/lib/neynar.ts` via the `api` fetcher
- Functions that make API calls: `getCronFeed()`, `getReplies()`, `getConversation()`, `getCasts()`
- Rate limits are enforced by Neynar's API (not client-side)
- Free tier limit: ~6 queries/second (for debugging/development only)
- Consider: retry logic, exponential backoff, request queuing, or delays between requests

## Code Patterns

- Uses `bun:sqlite` for database operations
- Uses `itty-fetcher` for HTTP requests
- Uses `radash` utilities (`diff`, `sift`, `unique`)
- Uses `tiny-invariant` for runtime assertions
- Uses `viem` for Ethereum wallet operations (x402)

## Known Limitations (WONTFIX)

From README:
- Does not show reactions (likes + recasts)
- Does not do all embeds, incl. quote casts
- No placeholders for frames / miniapps, videos, etc.

## Modifying the Codebase

**To change the FID being archived:**
- Edit `const FID` in `src/index.ts`

**To enable x402 payments:**
- Replace `api` with `x402api` in function calls within `src/lib/neynar.ts`
- Ensure `EOA_PRIVATE_KEY` is set and has sufficient ETH on Base chain

**To modify API endpoints:**
- Edit the URL strings in `src/lib/neynar.ts` functions
- Update TypeScript types from `@neynar/nodejs-sdk` if needed

**To change caching behavior:**
- Modify SQLite queries in `src/lib/neynar.ts`
- Cache database is `db/cache.db3`
