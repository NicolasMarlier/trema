#!/bin/bash
# Keep only the N most recent dumps per app in a directory.
# Usage: prune_dumps.sh [dir] [keep]
# Dump names: trema-<app>-YYYY-MM-DDTHHMM.sql (app = everything before the timestamp)
DIR="${1:-/db_dumps}"
KEEP="${2:-10}"
[[ -d "$DIR" ]] || exit 0

for f in "$DIR"/*.sql; do
    [[ -e "$f" ]] || continue
    b=$(basename "$f")
    echo "${b%-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9].sql}"
done | sort -u | while read -r app; do
    # timestamps sort lexicographically; newest first, skip KEEP
    ls -1 "$DIR" | grep -E "^$(printf '%s' "$app" | sed 's/[][\.*^$/]/\\&/g')-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}\.sql$" \
        | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
        rm -f -- "$DIR/$old"
    done
done
