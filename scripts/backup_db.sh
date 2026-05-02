#!/usr/bin/env bash
# options-calc daily SQLite backup. Keeps 30 days, atomic copy via .backup pragma.
set -euo pipefail

SRC="/home/ubuntu/options-calc/data/options.db"
DEST_DIR="/home/ubuntu/backup/options-calc"
KEEP_DAYS=30

mkdir -p "$DEST_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DEST="$DEST_DIR/options-${TS}.db"

if [ ! -f "$SRC" ]; then
    echo "[$(date -Is)] source DB missing: $SRC" >&2
    exit 0
fi

# Use sqlite3's .backup so we get a consistent snapshot even with WAL writers
sqlite3 "$SRC" ".backup '$DEST'"
gzip -f "$DEST"

# prune old backups
find "$DEST_DIR" -type f -name "options-*.db.gz" -mtime +"$KEEP_DAYS" -delete

echo "[$(date -Is)] backup ok -> $DEST.gz"
