#!/bin/sh
# Kiểm các nhánh bảo vệ dữ liệu bằng Docker/SSH giả; mọi file thử nằm trong worktree.
set -eu
repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "$repo/.env.backup-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
fixture="$tmp/máy chủ's"
mkdir -p "$fixture/src/deploy" "$tmp/bin"
cp "$repo"/deploy/backup*.sh "$repo/deploy/restore.sh" "$fixture/src/deploy/"
cp "$repo/deploy/compose.yaml" "$fixture/src/deploy/"
cat >"$fixture/.env" <<'ENV'
HIVE_COMPOSE_PROJECT=backup-test
HIVE_MASTER_KEY="a2hvYS1naWEtY2hpLWNoby10ZXN0LTMyLWJ5dGUhISE="
HIVE_DB_ADMIN_PASSWORD=mat-khau-gia-chi-cho-test
HIVE_BACKUP_KEEP=2
ENV
cp "$fixture/.env" "$tmp/env.goc"
# Khoá giả ở dạng chuẩn hoá: không ngoặc, không "=" đệm.
key=a2hvYS1naWEtY2hpLWNoby10ZXN0LTMyLWJ5dGUhISE
export MOCK_LOG="$tmp/docker.log" MOCK_CRONTAB="$tmp/crontab" MOCK_STAMP=20261011T030000Z
export MOCK_SQL="$tmp/restore.sql" MOCK_ENV="$fixture/.env"
export PATH="$tmp/bin:$PATH"
cat >"$tmp/bin/date" <<'MOCK'
#!/bin/sh
printf '%s\n' "$MOCK_STAMP"
MOCK
cat >"$tmp/bin/sleep" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat >"$tmp/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$MOCK_LOG"
if [ "$1" = inspect ]; then
  case "$*" in *Config.Env*) echo HIVE_VERSION=test-version ;; *) echo "${MOCK_HEALTH:-healthy}" ;; esac
  exit 0
fi
[ "$1" = compose ] || exit 1
while [ "$#" -gt 0 ]; do
  case "$1" in
    exec|ps|stop|up) op=$1; shift; break ;;
    *) shift ;;
  esac
done
case "$op" in
  ps) echo test-hub ;;
  stop|up) : ;;
  exec)
    case "$*" in
      *pg_dump*)
        [ "${MOCK_FAIL:-}" != dump ] || exit 1
        # Đổi khoá chủ giữa lúc dump: meta ghi trước đó không còn khớp.
        [ -z "${MOCK_ROTATE_KEY:-}" ] || printf 'HIVE_MASTER_KEY=khoa-moi\n' >>"$MOCK_ENV"
        echo custom-dump
        ;;
      *pg_restore*)
        cat >/dev/null
        case "$*" in
          *--list*) [ "${MOCK_FAIL:-}" != list ] || exit 1 ;;
          *) [ "${MOCK_FAIL:-}" != restore ] || exit 1 ;;
        esac
        ;;
      *count*) echo "${MOCK_ROLES:-4}" ;;
      *psql*) cat >>"$MOCK_SQL"; [ "${MOCK_FAIL:-}" != sql ] || exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
esac
MOCK
cat >"$tmp/bin/ssh" <<'MOCK'
#!/bin/sh
exec sh -c "$2"
MOCK
cat >"$tmp/bin/crontab" <<'MOCK'
#!/bin/sh
if [ "$1" = -l ]; then
  if [ -f "$MOCK_CRONTAB" ]; then cat "$MOCK_CRONTAB"; else echo 'no crontab for test' >&2; exit 1; fi
else
  cp "$1" "$MOCK_CRONTAB"
fi
MOCK
chmod +x "$tmp/bin/"*
backup() { sh "$fixture/src/deploy/backup.sh"; }
restore() { sh "$fixture/src/deploy/restore.sh" "$@"; }
fail() { echo "Kiểm tra thất bại: $*" >&2; exit 1; }
reject() { if "$@" >"$tmp/output" 2>&1; then fail "Lệnh lẽ ra phải lỗi: $*"; fi; }
no_stop() { if grep -q ' stop hub' "$MOCK_LOG"; then fail 'Đã dừng hub khi preflight lỗi.'; fi; }
sums() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

backup
first=$fixture/backups/$MOCK_STAMP
[ -s "$first/hive.dump" ] && [ -s "$first/meta" ] && [ -s "$first/SHA256SUMS" ] || fail 'Thiếu file backup.'
[ ! -e "$first/.env" ] || fail 'Bản sao lưu vẫn chép .env.'
if grep -rqF -e "$key" -e mat-khau-gia-chi-cho-test "$first"; then fail 'Bản sao lưu chứa secret.'; fi
key_sha=$(printf '%s' "$key" | sums | cut -d ' ' -f 1)
printf 'HIVE_COMPOSE_PROJECT=backup-test\nHIVE_MASTER_KEY_SHA256=%s\n' "$key_sha" | cmp -s - "$first/meta" ||
  fail 'meta sai project hoặc dấu khoá.'
[ "$(awk '{ print $2 }' "$first/SHA256SUMS" | tr '\n' ' ')" = 'hive.dump meta ' ] || fail 'SHA256SUMS phải phủ đúng hive.dump và meta.'
python3 - "$first" <<'PY'
import pathlib, stat, sys
p = pathlib.Path(sys.argv[1])
assert stat.S_IMODE(p.stat().st_mode) == 0o700
assert stat.S_IMODE(p.parent.stat().st_mode) == 0o700
for name in ['hive.dump', 'meta', 'SHA256SUMS']:
    assert stat.S_IMODE((p / name).stat().st_mode) == 0o600
PY
grep -q 'compose -p backup-test .* exec -T postgres pg_dump -U postgres -Fc hive' "$MOCK_LOG" || fail 'Sai project/lệnh dump.'
export MOCK_STAMP=20261012T030000Z
reject env HIVE_BACKUP_KEEP=0 sh "$fixture/src/deploy/backup.sh"
reject env MOCK_FAIL=dump sh "$fixture/src/deploy/backup.sh"
reject env MOCK_FAIL=list sh "$fixture/src/deploy/backup.sh"
reject env MOCK_ROTATE_KEY=1 sh "$fixture/src/deploy/backup.sh"
grep -q 'HIVE_MASTER_KEY trong .env đã thay đổi' "$tmp/output" || fail 'Khoá đổi khi sao lưu nhưng không báo.'
cp "$tmp/env.goc" "$fixture/.env"
[ -d "$first" ] || fail 'Backup lỗi đã xoá bản cũ.'
[ ! -d "$fixture/backups/$MOCK_STAMP" ] || fail 'Đã công bố backup lỗi.'
[ ! -d "$fixture/.backup-restore.lock" ] || fail 'Chưa giải phóng khoá.'
backup
export MOCK_STAMP=20261013T030000Z
backup
[ ! -d "$first" ] || fail 'Không xoá bản cũ theo retention.'
saved=$fixture/backups/$MOCK_STAMP
mkdir "$fixture/.backup-restore.lock"
reject backup
rmdir "$fixture/.backup-restore.lock"

# Bản sao lưu mới: kiểm checksum (cả meta), project và dấu khoá trước khi dừng hub; dùng .env đang có, không hỏi ghi đè.
cp -R "$saved" "$tmp/corrupt"
printf 'hong' >>"$tmp/corrupt/hive.dump"
: >"$MOCK_LOG"
reject restore "$tmp/corrupt" --yes
cp -R "$saved" "$tmp/meta-sua"
printf '# sua\n' >>"$tmp/meta-sua/meta"
reject restore "$tmp/meta-sua" --yes
grep -q 'Checksum không khớp' "$tmp/output" || fail 'Checksum chưa phủ meta.'
cp -R "$saved" "$tmp/project-khac"
sed 's/^HIVE_COMPOSE_PROJECT=.*/HIVE_COMPOSE_PROJECT=project-khac/' "$saved/meta" >"$tmp/project-khac/meta"
(cd "$tmp/project-khac" && sums hive.dump meta >SHA256SUMS)
reject restore "$tmp/project-khac" --yes
grep -q 'compose project khác' "$tmp/output" || fail 'Không chặn bản sao lưu của project khác.'
cp -R "$saved" "$tmp/thieu-meta"
rm "$tmp/thieu-meta/meta"
reject restore "$tmp/thieu-meta" --yes
grep -q 'thiếu meta' "$tmp/output" || fail 'Không báo thiếu meta.'
sed 's/^HIVE_MASTER_KEY=.*/HIVE_MASTER_KEY=khoa-khac/' "$tmp/env.goc" >"$fixture/.env"
reject restore "$saved" --yes
grep -q '.env gốc' "$tmp/output" || fail 'Lệch khoá nhưng không nói cần .env gốc.'
no_stop
# Hub đọc các cách viết này là cùng một khoá (lúc sao lưu khoá có ngoặc): restore không được báo lệch khoá.
for line in "HIVE_MASTER_KEY=$key=" "HIVE_MASTER_KEY=$key=   " "HIVE_MASTER_KEY=$key= # khoá chủ, không đổi"   "HIVE_MASTER_KEY=$key" "HIVE_MASTER_KEY='$key='"; do
  sed "s|^HIVE_MASTER_KEY=.*|$line|" "$tmp/env.goc" >"$fixture/.env"
  restore "$saved" </dev/null >"$tmp/output" 2>&1 || fail "Báo lệch khoá dù cùng khoá: $line"
done
: >"$MOCK_LOG"
cp "$tmp/env.goc" "$fixture/.env"
printf 'HIVE_PUBLIC_URL=https://doi.example.com\n' >>"$fixture/.env"
cp "$fixture/.env" "$tmp/env.hien-tai"
reject env MOCK_ROLES=3 sh "$fixture/src/deploy/restore.sh" "$saved" --yes
no_stop
reject env MOCK_FAIL=restore sh "$fixture/src/deploy/restore.sh" "$saved" --yes
reject env MOCK_FAIL=sql sh "$fixture/src/deploy/restore.sh" "$saved" --yes
if grep -q ' up ' "$MOCK_LOG"; then fail 'Hub đã chạy lại sau restore lỗi.'; fi
cmp -s "$fixture/.env" "$tmp/env.hien-tai" || fail '.env đổi dù restore lỗi.'
: >"$MOCK_LOG"
restore "$saved" </dev/null
cmp -s "$fixture/.env" "$tmp/env.hien-tai" || fail 'Restore bản sao lưu mới đã sửa .env.'
grep -q -- 'pg_restore --clean --if-exists' "$MOCK_LOG" || fail 'Thiếu clean restore.'
grep -q -- 'psql -U postgres -d hive -v ON_ERROR_STOP=1' "$MOCK_LOG" || fail 'Restore không dừng khi SQL lỗi.'
if ! grep -q '^BEGIN;' "$MOCK_SQL" || ! grep -q '^DROP SCHEMA IF EXISTS pgboss CASCADE;' "$MOCK_SQL" || ! grep -q '^COMMIT;' "$MOCK_SQL"; then
  fail 'Thiếu transaction chung cho schema và dump.'
fi
grep -q 'up -d --no-build --no-deps --force-recreate hub' "$MOCK_LOG" || fail 'Không tái tạo hub.'

# Bản sao lưu cũ (trước khi tách .env) vẫn khôi phục được như trước: hỏi trước khi ghi đè .env đang có.
legacy=$tmp/ban-cu
mkdir "$legacy"
cp "$saved/hive.dump" "$legacy/"
cp "$tmp/env.goc" "$legacy/.env"
(cd "$legacy" && sums hive.dump .env >SHA256SUMS)
cp -R "$legacy" "$tmp/ban-cu-hong"
printf 'hong' >>"$tmp/ban-cu-hong/.env"
: >"$MOCK_LOG"
reject restore "$tmp/ban-cu-hong" --yes
grep -q 'Checksum không khớp' "$tmp/output" || fail 'Checksum bản cũ chưa phủ .env.'
reject restore "$legacy" </dev/null
grep -q 'Đã huỷ' "$tmp/output" || fail 'Bản cũ không hỏi trước khi ghi đè .env.'
no_stop
cmp -s "$fixture/.env" "$tmp/env.hien-tai" || fail 'Đã ghi đè .env khi không xác nhận.'
printf 'y\n' | restore "$legacy"
cmp -s "$fixture/.env" "$legacy/.env" || fail 'Không nạp lại .env của bản sao lưu cũ.'
grep -q 'up -d --no-build --no-deps --force-recreate hub' "$MOCK_LOG" || fail 'Không tái tạo hub sau khi khôi phục bản cũ.'
: >"$MOCK_LOG"
reject env MOCK_HEALTH=unhealthy sh "$fixture/src/deploy/restore.sh" "$saved" --yes
tail -n 1 "$MOCK_LOG" | grep -q ' stop hub' || fail 'Hub không healthy nhưng chưa bị dừng lại.'

export MOCK_STAMP=20261014T030000Z HIVE_REMOTE_DIR="$fixture"
printf '0 1 * * * echo lich-khac\n' >"$MOCK_CRONTAB"
printf '0 2 * * * echo project-khac # xdev-hive-backup: %s-khac\n' "$fixture" >>"$MOCK_CRONTAB"
sh "$repo/deploy/remote-backup.sh" 'user@may-chu' --cron '0 3 * * *'
export MOCK_STAMP=20261015T030000Z
sh "$repo/deploy/remote-backup.sh" 'user@may-chu' --cron '0 4 * * *'
[ "$(grep -c '# xdev-hive-backup:' "$MOCK_CRONTAB")" -eq 2 ] || fail 'Cron bị trùng hoặc mất project khác.'
grep -q 'project-khac' "$MOCK_CRONTAB" || fail 'Mất lịch của project có chung tiền tố đường dẫn.'
grep -q '0 1 .* lich-khac' "$MOCK_CRONTAB" || fail 'Mất lịch khác.'
grep -q '^0 4 ' "$MOCK_CRONTAB" || fail 'Cron chưa cập nhật.'
reject sh "$repo/deploy/remote-backup.sh" 'user@may-chu' --cron '0 3 * * *; echo chen-lenh'
echo 'Đạt: quyền file, meta không có secret, project, dấu khoá, retention, lỗi dump/list/checksum, khoá, bản cũ có .env, xác nhận, restore lỗi và cron không trùng.'
