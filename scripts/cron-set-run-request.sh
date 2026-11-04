#!/bin/sh
# Set the run-request marker in R2 (the inverted lockfile). The every-minute
# poller (scripts/poll-run-request.ts) consumes it and runs the pipeline.
cd /home/artlu/my_repos/nano-farchiver || exit 1
exec /home/artlu/.bun/bin/bun scripts/set-run-request.ts
