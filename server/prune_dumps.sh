#!/bin/bash
# Keep only the N most recent dumps per app in a directory.
# Usage: prune_dumps.sh [dir] [keep]
# Dump names: trema-<app>-YYYY-MM-DDTHHMM[-pre-restore|-upload].(sql|dump|sql.gz)  (app = everything before the timestamp)
DIR="${1:-/db_dumps}"
KEEP="${2:-10}"
[[ -d "$DIR" ]] || exit 0

TS='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}'
SUFFIX='(-pre-restore|-upload)?\.(sql|dump|sql\.gz)'

ls -1 "$DIR" | sed -nE "s/^(trema-.+)-$TS$SUFFIX\$/\1/p" | sort -u | while read -r app; do
    # timestamps sort lexicographically (sort on the part after the app name); newest first, skip KEEP
    ls -1 "$DIR" | grep -E "^$(printf '%s' "$app" | sed 's/[][\.*^$/]/\\&/g')-$TS$SUFFIX\$" \
        | sed -E "s/^(.*)-($TS)(.*)\$/\2 \1-\2\3/" | sort -r | tail -n +"$((KEEP + 1))" | cut -d' ' -f2 | while read -r old; do
        rm -f -- "$DIR/$old"
    done
done
