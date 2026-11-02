#!/bin/bash
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $1"; exit 1; }

# prune
mkdir "$T/d"
for i in $(seq -w 1 12); do touch "$T/d/trema-my-app-2026-01-${i}T1000.sql"; touch "$T/d/trema-other-2026-01-${i}T1000.sql"; done
touch "$T/d/notes.txt"
bash server/prune_dumps.sh "$T/d" 10
[[ $(ls "$T/d"/trema-my-app-* | wc -l) -eq 10 ]] || fail "my-app keep 10"
[[ $(ls "$T/d"/trema-other-* | wc -l) -eq 10 ]] || fail "other keep 10"
[[ -e "$T/d/trema-my-app-2026-01-12T1000.sql" && ! -e "$T/d/trema-my-app-2026-01-01T1000.sql" ]] || fail "newest kept"
[[ -e "$T/d/notes.txt" ]] || fail "non-dump kept"

# setup idempotent
mkdir -p "$T/r"
TREMA_ROOT="$T/r" bash server/setup.sh >/dev/null
a=$(cat "$T/r/etc/docker/daemon.json")
TREMA_ROOT="$T/r" bash server/setup.sh >/dev/null
[[ "$a" == "$(cat "$T/r/etc/docker/daemon.json")" ]] || fail "idempotent"
grep -q '"max-size"' "$T/r/etc/docker/daemon.json" || fail "max-size"
[[ -f "$T/r/etc/cron.d/trema-prune-dumps" ]] || fail "cron"
# deploy safety checks (dry run, no network)
H="$T/home"; mkdir -p "$H"; printf 'TREMA_HOSTNAME=h\nTREMA_USERNAME=u\n' > "$H/.trema_config"
if HOME="$T/nohome" TREMA_DEPLOY_DRY_RUN=1 bash bin/trema-deploy >/dev/null 2>&1; then fail "deploy without config"; fi
R="$T/repo"; git init -q -b feature "$R"; mkdir "$R/bin"; cp bin/trema bin/trema-config bin/trema-deploy "$R/bin/"
git -C "$R" add -A; git -C "$R" -c user.email=a@b -c user.name=t commit -qm i
if HOME="$H" TREMA_DEPLOY_DRY_RUN=1 bash "$R/bin/trema-deploy" >/dev/null 2>&1; then fail "deploy from non-main"; fi
git -C "$R" branch -m main
HOME="$H" TREMA_DEPLOY_DRY_RUN=1 bash "$R/bin/trema-deploy" >/dev/null 2>&1 || fail "deploy dry run on clean main"
touch "$R/dirty"
if HOME="$H" TREMA_DEPLOY_DRY_RUN=1 bash "$R/bin/trema-deploy" >/dev/null 2>&1; then fail "deploy dirty"; fi
echo "OK"
