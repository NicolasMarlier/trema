#!/bin/bash
# Idempotent server setup (run on the VM, as root or with sudo):
#  - Docker default log rotation in /etc/docker/daemon.json
#  - daily cron pruning /db_dumps (keep last 10 per app)
#  - dedicated non-root user (TREMA_USER, default trema, docker group) owning /db_dumps and /etc/nginx/trema.d
#  - the only 2 root commands the user may run without password: trema-nginx-reload, trema-cert <domain>
# Env: TREMA_HOST (required with the user setup: base domain), TREMA_USER, TREMA_RESTART_DOCKER=yes|no|ask (default ask), TREMA_ROOT (testing), 
set -e
ROOT="${TREMA_ROOT:-}"
MAX_SIZE="${TREMA_LOG_MAX_SIZE:-20m}"
MAX_FILE="${TREMA_LOG_MAX_FILE:-5}"
KEEP="${TREMA_DUMPS_KEEP:-10}"
TREMA_USER="${TREMA_USER:-trema}"
HOST="${TREMA_HOST:-}"
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

# ---- Dedicated user, nginx vhost dir, root scripts, sudoers ----
[[ "$TREMA_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Invalid TREMA_USER" >&2; exit 1; }
if [[ -z "$ROOT" ]]; then
    if id "$TREMA_USER" >/dev/null 2>&1; then
        usermod -aG docker "$TREMA_USER" 2>/dev/null || true
    else
        useradd --create-home --shell /bin/bash --groups docker "$TREMA_USER"
        echo "ℹ️  User $TREMA_USER created: set a password (sudo passwd $TREMA_USER) and add your SSH key."
    fi
fi
echo "✅ User $TREMA_USER (docker group)"

mkdir -p "$ROOT/db_dumps" "$ROOT/etc/nginx/trema.d" "$ROOT/etc/nginx/conf.d" "$ROOT/etc/trema" "$ROOT/usr/local/sbin" "$ROOT/etc/sudoers.d"
if [[ -z "$ROOT" ]]; then chown "$TREMA_USER": /db_dumps /etc/nginx/trema.d; fi
echo 'include /etc/nginx/trema.d/*;' > "$ROOT/etc/nginx/conf.d/trema.conf"
if [[ -n "$HOST" ]]; then echo "$HOST" > "$ROOT/etc/trema/host"; fi
[[ -f "$ROOT/etc/trema/host" ]] || { echo "TREMA_HOST missing: cannot configure trema-cert" >&2; exit 1; }
echo "✅ /db_dumps and /etc/nginx/trema.d owned by $TREMA_USER"

for s in trema-nginx-reload trema-cert; do install -m 755 "$HERE/$s" "$ROOT/usr/local/sbin/$s"; done
SUDOERS="$ROOT/etc/sudoers.d/trema"
cat > "$SUDOERS.tmp" <<EOF
# Managed by trema server:setup. Only these two commands, without password.
$TREMA_USER ALL=(root) NOPASSWD: /usr/local/sbin/trema-nginx-reload, /usr/local/sbin/trema-cert *
EOF
chmod 440 "$SUDOERS.tmp"
if [[ -z "$ROOT" ]] && ! visudo -cf "$SUDOERS.tmp" >/dev/null; then rm -f "$SUDOERS.tmp"; echo "❌ invalid sudoers rule" >&2; exit 1; fi
mv "$SUDOERS.tmp" "$SUDOERS"
rm -f "$ROOT/etc/sudoers.d/trema-ui"   # legacy wildcard certbot rule
echo "✅ sudo without password limited to trema-nginx-reload and trema-cert <domain>"
