# nano-farchiver

**[Farchiver](https://farchiver.xyz)** uses direct access to the network, and can never be blocked due to modularity, and ability to re-route to multiple data sources.

 However, it is quite expensive to run that way.

`nano farchiver` is a weekend project that leverages free + paid SAAS. It may be censorable, but it costs very little.

## RUNNING

To run:

0. set `ENV` variables for API access

```bash
cp .env.example .env.local
vi .env.local
```

1. set `const FID` in `src/index.ts`

2. run the script

```bash
bun doIt
```

3. bundle the outputs into a gzipped tarball

```bash
bun run bundle
```

4. (optional) clean up

```bash
bun clean
bun clear
```

## DEVELOPING

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts
```

This project was created using `bun init` in bun v1.3.3. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

### WONTFIX

- [ ] does not show reactions (likes + recasts)
- [ ] does not do all embeds, incl. quote casts
- [ ] no placeholders for frames / miniapps, videos, etc.
