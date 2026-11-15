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
export TREMA_HOST=ex.fr
TREMA_ROOT="$T/r" bash server/setup.sh >/dev/null
a=$(cat "$T/r/etc/docker/daemon.json")
TREMA_ROOT="$T/r" bash server/setup.sh >/dev/null
[[ "$a" == "$(cat "$T/r/etc/docker/daemon.json")" ]] || fail "idempotent"
grep -q '"max-size"' "$T/r/etc/docker/daemon.json" || fail "max-size"
[[ -f "$T/r/etc/cron.d/trema-prune-dumps" ]] || fail "cron"
# non-root setup: sudoers, scripts, vhost dir
SU="$T/r/etc/sudoers.d/trema"
[[ -f "$SU" ]] || fail "sudoers file"
grep -q 'NOPASSWD: /usr/local/sbin/trema-nginx-reload, /usr/local/sbin/trema-cert \*' "$SU" || fail "sudoers rule"
[[ $(grep -c NOPASSWD "$SU") -eq 1 ]] || fail "single sudoers rule"
! grep -q certbot "$SU" || fail "no raw certbot in sudoers"
[[ -x "$T/r/usr/local/sbin/trema-cert" && -x "$T/r/usr/local/sbin/trema-nginx-reload" && -d "$T/r/etc/nginx/trema.d" ]] || fail "root scripts / trema.d"
grep -q 'trema.d' "$T/r/etc/nginx/conf.d/trema.conf" || fail "nginx include"
[[ "$(cat "$T/r/etc/trema/host")" == ex.fr ]] || fail "host file"
# trema-cert validates its arguments
tc() { TREMA_ROOT="$T/r" TREMA_CERT_DRY_RUN=1 bash server/trema-cert "$@" 2>&1; }
tc blog.ex.fr | grep -q -- "--domains blog.ex.fr" || fail "cert ok domain"
tc my-app.ex.fr >/dev/null || fail "cert hyphen domain"
for bad in other.com blog.ex.fr.evil.com "--help" "x.ex.fr --staging" "ex.fr" "a b.ex.fr" "-d.ex.fr" "blog.exxfr"; do
    if tc "$bad" >/dev/null; then fail "cert accepted '$bad'"; fi
done
if tc a.ex.fr b.ex.fr >/dev/null; then fail "cert two args"; fi
if tc >/dev/null; then fail "cert no arg"; fi
if bash server/trema-nginx-reload x >/dev/null 2>&1; then fail "reload with arg"; fi
# migration: replayed twice
M="$T/m"; mkdir -p "$M/root/.ssh" "$M/root/repos/my_app.git" "$M/root/apps/my_app" "$M/root/trema-ui/ui" "$M/etc/nginx/sites-enabled" "$M/etc/nginx/trema.d"
echo "ssh-ed25519 AAA k1" > "$M/root/.ssh/authorized_keys"
echo "server_name my-app.ex.fr;" > "$M/etc/nginx/sites-enabled/my-app"
echo "server_name trema.ex.fr;" > "$M/etc/nginx/sites-enabled/trema-ui"
echo "server_name keep.ex.fr;" > "$M/etc/nginx/sites-enabled/unrelated"
printf 'User=__USER__\nWorkingDirectory=__HOME__/trema-ui\n' > "$M/root/trema-ui/ui/trema-ui.service"
mig() { TREMA_ROOT="$M" SRC_HOME="$M/root" TREMA_HOST=ex.fr bash server/migrate_user.sh; }
mig >/dev/null || fail "migrate"
mig | grep -q MIGRATE_OK || fail "migrate replay"
[[ -d "$M/home/trema/repos/my_app.git" && -d "$M/home/trema/apps/my_app" && ! -e "$M/root/repos" ]] || fail "dirs moved"
[[ -f "$M/etc/nginx/trema.d/my-app" && -f "$M/etc/nginx/trema.d/trema-ui" && ! -e "$M/etc/nginx/sites-enabled/my-app" ]] || fail "vhosts moved"
[[ -f "$M/etc/nginx/sites-enabled/unrelated" ]] || fail "unrelated vhost kept"
[[ $(wc -l < "$M/home/trema/.ssh/authorized_keys") -eq 1 ]] || fail "keys not duplicated"
grep -q "User=trema" "$M/etc/systemd/system/trema-ui.service" || fail "service user"
grep -q "WorkingDirectory=/home/trema/trema-ui" "$M/etc/systemd/system/trema-ui.service" || fail "service home"
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
printf 'TREMA_HOSTNAME=h.fr\nTREMA_USERNAME=root\n' > "$HH/.trema_config"
out=$(t server:setup); grep -q "TREMA_USER=trema " <<<"$out" || fail "server:setup as root targets trema: $out"
out=$(TREMA_NEW_USER=bob t server:setup); grep -q "TREMA_USER=bob " <<<"$out" || fail "TREMA_NEW_USER: $out"
printf 'TREMA_HOSTNAME=h.fr\nTREMA_USERNAME=u\n' > "$HH/.trema_config"
out=$(t init); grep -q "Usage" <<<"$out" || fail "init => usage"
cd "$ROOT_DIR"
echo "OK"
