#!/bin/bash
# Moves an existing root-based Trema install to the dedicated user (run on the VM, as root). Idempotent:
# each step skips what is already done. No container is recreated (compose project names do not change).
# Env: TREMA_USER (default trema), TREMA_HOST (required), SRC_HOME (default $HOME), TREMA_ROOT (testing: no system command).
set -e
ROOT="${TREMA_ROOT:-}"
TREMA_USER="${TREMA_USER:-trema}"
SRC_HOME="${SRC_HOME:-$HOME}"
DEST_HOME="${DEST_HOME:-$ROOT/home/$TREMA_USER}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -n "$TREMA_HOST" ]] || { echo "TREMA_HOST missing" >&2; exit 1; }
[[ -n "$ROOT" || $(id -u) -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ "$SRC_HOME" != "$DEST_HOME" ]] || { echo "Already running as $TREMA_USER: nothing to migrate."; exit 0; }
step() { echo "[$1/6] $2"; }
sys() { [[ -n "$ROOT" ]] || "$@"; }
sanitize() { echo "${1//_/-}"; }

step 1 "User $TREMA_USER, root scripts, sudoers (server/setup.sh)"
TREMA_RESTART_DOCKER=no TREMA_USER="$TREMA_USER" TREMA_HOST="$TREMA_HOST" bash "$HERE/setup.sh" >/dev/null
[[ -n "$ROOT" ]] && mkdir -p "$DEST_HOME"
echo " ✓ ok"

step 2 "Authorized SSH keys copied"
if [[ -f "$SRC_HOME/.ssh/authorized_keys" ]]; then
    mkdir -p "$DEST_HOME/.ssh"; chmod 700 "$DEST_HOME/.ssh"
    touch "$DEST_HOME/.ssh/authorized_keys"
    while IFS= read -r key; do
        [[ -n "$key" ]] && ! grep -qxF "$key" "$DEST_HOME/.ssh/authorized_keys" && echo "$key" >> "$DEST_HOME/.ssh/authorized_keys"
    done < "$SRC_HOME/.ssh/authorized_keys"
    chmod 600 "$DEST_HOME/.ssh/authorized_keys"
    sys chown -R "$TREMA_USER": "$DEST_HOME/.ssh"
    echo " ✓ $(wc -l < "$DEST_HOME/.ssh/authorized_keys" | tr -d ' ') key(s)"
else echo " - no authorized_keys"; fi

step 3 "Moving repos apps envs docker_compose_files trema-ui → $DEST_HOME"
for d in repos apps envs docker_compose_files trema-ui; do
    if [[ -e "$SRC_HOME/$d" && ! -e "$DEST_HOME/$d" ]]; then mv "$SRC_HOME/$d" "$DEST_HOME/$d"; echo " ✓ $d"
    elif [[ -e "$SRC_HOME/$d" ]]; then echo " ⚠ $d exists in both places, left untouched in $SRC_HOME"
    fi
done
sys chown -R "$TREMA_USER": "$DEST_HOME"
# Git refuses repos owned by someone else only when ownership differs: chown above avoids it.
sys chown "$TREMA_USER": /db_dumps 2>/dev/null || true
sys chown -R "$TREMA_USER": /db_dumps 2>/dev/null || true

step 4 "Vhosts → /etc/nginx/trema.d"
SITES="${SITES_DIR:-$ROOT/etc/nginx/sites-enabled}"; TD="$ROOT/etc/nginx/trema.d"; mkdir -p "$TD"
names=(trema-ui)
for d in "$DEST_HOME"/apps/* "$DEST_HOME"/repos/*; do [[ -e "$d" ]] && names+=("$(sanitize "$(basename "$d" .git)")"); done
for n in $(printf '%s\n' "${names[@]}" | sort -u); do
    if [[ -e "$SITES/$n" && ! -e "$TD/$n" ]]; then cp -L "$SITES/$n" "$TD/$n"; rm -f "$SITES/$n"; echo " ✓ $n"
    elif [[ -e "$SITES/$n" && -e "$TD/$n" ]]; then rm -f "$SITES/$n"; echo " ✓ $n (duplicate removed)"; fi
done
sys chown -R "$TREMA_USER": "$TD"
if [[ -z "$ROOT" ]]; then nginx -t && systemctl reload nginx; fi
echo " ✓ nginx -t OK, reload"

step 5 "Service trema-ui → User=$TREMA_USER"
UNIT="$ROOT/etc/systemd/system/trema-ui.service"
if [[ -f "$DEST_HOME/trema-ui/ui/trema-ui.service" ]]; then
    mkdir -p "$(dirname "$UNIT")"
    sed -e "s|__USER__|$TREMA_USER|g" -e "s|__HOME__|${DEST_HOME#$ROOT}|g" "$DEST_HOME/trema-ui/ui/trema-ui.service" > "$UNIT"
    if [[ -z "$ROOT" ]]; then systemctl daemon-reload; systemctl restart trema-ui; fi
    echo " ✓ restarted"
else echo " - UI not installed"; fi

step 6 "Docker access for $TREMA_USER"
if [[ -z "$ROOT" ]]; then su - "$TREMA_USER" -c 'docker ps -q | wc -l' | sed 's/^/ ✓ running containers: /'; else echo " - skipped"; fi
echo "MIGRATE_OK"
