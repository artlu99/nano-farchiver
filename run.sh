#!/bin/sh
# Secrets (X402_API_KEY, etc.) live in .env (gitignored, auto-loaded by Bun)
# or the process environment — never inline in this file.
PORT=8080 PUBLIC_APP_URL=https://decent-artlu.farchiver.xyz/ nohup bun --watch serve.ts &
