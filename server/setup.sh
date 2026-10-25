#!/bin/bash
# Idempotent server setup (run on the VM, as root or with sudo):
#  - Docker default log rotation in /etc/docker/daemon.json
#  - daily cron pruning /db_dumps (keep last 10 per app)
# Env: TREMA_RESTART_DOCKER=yes|no|ask (default ask), TREMA_ROOT (testing), 
set -e
ROOT="${TREMA_ROOT:-}"
MAX_SIZE="${TREMA_LOG_MAX_SIZE:-20m}"
MAX_FILE="${TREMA_LOG_MAX_FILE:-5}"
KEEP="${TREMA_DUMPS_KEEP:-10}"
HERE="$(cd "$(dirname "$0")" && pwd)"

DAEMON="$ROOT/etc/docker/daemon.json"
mkdir -p "$(dirname "$DAEMON")"
[[ -f "$DAEMON" ]] || echo '{}' > "$DAEMON"
before=$(cat "$DAEMON")
if command -v jq >/dev/null; then
    jq --arg s "$MAX_SIZE" --arg f "$MAX_FILE" \
       '. + {"log-driver":"json-file"} | ."log-opts" = ((."log-opts" // {}) + {"max-size":$s,"max-file":$f})' \
       "$DAEMON" > "$DAEMON.tmp"
    mv "$DAEMON.tmp" "$DAEMON"
else
    if [[ "$before" == "{}" ]]; then
        printf '{\n  "log-driver": "json-file",\n  "log-opts": {"max-size": "%s", "max-file": "%s"}\n}\n' "$MAX_SIZE" "$MAX_FILE" > "$DAEMON"
    elif ! grep -q max-size "$DAEMON"; then
        echo "jq missing and $DAEMON not empty: install jq (apt install jq)" >&2; exit 1
    fi
fi
changed=no
[[ "$(cat "$DAEMON")" != "$before" ]] && changed=yes
echo "✅ Docker log rotation: $MAX_SIZE x $MAX_FILE ($DAEMON)"

install -m 755 "$HERE/prune_dumps.sh" "$ROOT/usr/local/bin/trema-prune-dumps" 2>/dev/null || {
    mkdir -p "$ROOT/usr/local/bin"; install -m 755 "$HERE/prune_dumps.sh" "$ROOT/usr/local/bin/trema-prune-dumps"; }
mkdir -p "$ROOT/etc/cron.d"
echo "0 3 * * * root /usr/local/bin/trema-prune-dumps /db_dumps $KEEP" > "$ROOT/etc/cron.d/trema-prune-dumps"
echo "✅ Daily cron: keep last $KEEP dumps per app"

if [[ -z "$ROOT" && "$changed" == yes ]]; then
    mode="${TREMA_RESTART_DOCKER:-ask}"
    if [[ "$mode" == ask && -t 0 ]]; then
        read -p "Restart Docker now to apply (restarts containers without live-restore)? [y/N] " a
        [[ "$a" =~ ^[yY] ]] && mode=yes || mode=no
    fi
    if [[ "$mode" == yes ]]; then systemctl restart docker; echo "✅ Docker restarted"
    else echo "ℹ️  Applied at next Docker restart; containers need --force-recreate."; fi
fi
