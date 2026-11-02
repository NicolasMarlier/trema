#!/bin/bash
set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT_DIR"
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
# CLI: app resolution, legacy trema.env, no init
T2="$T/cli"; HH="$T2/home"; mkdir -p "$HH" "$T2/bin"; cp bin/trema bin/trema-config "$T2/bin/"
printf 'TREMA_HOSTNAME=h.fr\nTREMA_USERNAME=u\n' > "$HH/.trema_config"
cat > "$T2/bin/ssh" <<'SH'
#!/bin/bash
echo "SSH $*"
SH
chmod +x "$T2/bin/ssh"
P="$T2/bin:$PATH"
W="$T2/work"; git init -q -b main "$W"; cd "$W"
t() { HOME="$HH" PATH="$P" bash "$T2/bin/trema" "$@" 2>&1; }
out=$(t logs) && fail "logs without app"; grep -q "no Trema app" <<<"$out" || fail "no-remote message"
out=$(t logs --app blog) || fail "--app"; grep -q "docker logs -f blog-web-1" <<<"$out" || fail "--app name: $out"
git remote add trema u@h.fr:repos/shop
out=$(t logs) || fail "remote app"; grep -q "shop-web-1" <<<"$out" || fail "remote name: $out"
out=$(t logs --app blog); grep -q "blog-web-1" <<<"$out" || fail "--app overrides remote"
out=$(t config); grep -q "Current app: shop" <<<"$out" || fail "config shows app"
git remote set-url trema u@other.fr:repos/shop
out=$(t logs) && fail "other host"; grep -q "points to other.fr" <<<"$out" || fail "host mismatch msg"
git remote set-url trema u@h.fr:repos/shop
printf 'TREMA_HOSTNAME=old.fr\nTREMA_USERNAME=u\n' > trema.env
out=$(t logs); [[ ! -e trema.env ]] || fail "trema.env not removed"; grep -q "differed" <<<"$out" || fail "diff warning"
printf 'TREMA_HOSTNAME=h.fr\nTREMA_USERNAME=u\n' > trema.env
out=$(t ssh); [[ ! -e trema.env ]] || fail "trema.env not removed (same)"; grep -q "Removed trema.env" <<<"$out" || fail "removal msg"
cd /; out=$(HOME="$HH" PATH="$P" bash "$T2/bin/trema" ssh 2>&1) || fail "global cmd outside project"
out=$(HOME="$T2/none" PATH="$P" bash "$T2/bin/trema" ssh 2>&1) && fail "no global config"; grep -q "config:edit --global" <<<"$out" || fail "no config msg"
out=$(t init); grep -q "Usage" <<<"$out" || fail "init => usage"
cd "$ROOT_DIR"
echo "OK"
