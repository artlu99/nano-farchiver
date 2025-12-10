# nano-farchiver

**[Farchiver](https://farchiver.xyz)** uses direct access to the network, and can never be blocked due to modularity, and ability to re-route to multiple data sources.

 However, it is quite expensive to run that way.

`nano farchiver` is a weekend project that leverages free + paid SAAS. It may be censorable, but it costs very little.

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Set up environment variables:**
   Create a `.env.local` file (or `.env`) with the required API keys:
   ```bash
   NEYNAR_API_KEY=your_neynar_api_key_here
   EOA_PRIVATE_KEY=your_eoa_private_key_here
   ```
   
   - `NEYNAR_API_KEY`: Your Neynar API key (get one at [neynar.com](https://neynar.com))
   - `EOA_PRIVATE_KEY`: Your Ethereum wallet private key (for x402 payments, if using that option)

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

## Rate Limits & Production Usage

When running in production, you'll encounter rate limits depending on your setup. Here are your options, from most convenient to most basic:

### Option 1: Neynar Subscription (Recommended for Production)

**With a Neynar subscription ($9/month, pay by the month):**
- ✅ Avoids all rate limits
- ✅ Just run the script without any special configuration
- ✅ Most reliable for production use

Simply ensure your `NEYNAR_API_KEY` is from a paid Neynar subscription account, and you can run the script without worrying about rate limits.

### Option 2: x402 Payment System

**Without a subscription, you can set up x402:**
- Set your `EOA_PRIVATE_KEY` in the `.env` file (this is already required)
- The code includes x402 support via `x402-fetch` package
- This allows pay-per-request access to the Neynar API

### Option 3: Paid Farchiver Customer

**Alternative option:**
- Pay **0.0069 ETH** as a paid Farchiver customer
- This gives you access to Farchiver's direct network access (see above for more details)

## Troubleshooting

**Rate limit errors:**
- If you see rate limit errors, you may be using a free tier API key (limited to ~6 queries/second)
- For debugging: The built-in caching system (`db/cache.db3`) helps avoid redundant API calls
- For production use: Consider upgrading to a Neynar subscription or using x402 payment system

**Missing environment variables:**
- Ensure both `NEYNAR_API_KEY` and `EOA_PRIVATE_KEY` are set
- The code will throw an error if either is missing

**Cache issues:**
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
