#!/bin/sh
# Store-backed archiver run for cron. Single-writer is enforced mechanically:
# flock makes overlapping cron ticks a no-op while a run is still active.
cd /home/artlu/my_repos/nano-farchiver || exit 1

LOGDIR=logs
mkdir -p "$LOGDIR"

# non-blocking lock: a second run while one is active simply skips
exec 9>>"$LOGDIR/doit.lock"
if ! flock -n 9; then
	echo "$(date -Is) previous run still active — skipping tick"
	exit 0
fi

exec >> "$LOGDIR/archiver-$(date +%Y%m%d).log" 2>&1
echo "=== $(date -Is) run start (ARCHIVE_BACKEND=store) ==="
ARCHIVE_BACKEND=store exec /home/artlu/.bun/bin/bun run doIt
