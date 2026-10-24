#!/bin/sh
# Diễn tập khôi phục hằng tháng (spec 027 FR-041). Chạy trên máy chủ: <dir>/src/deploy/drill.sh. Không dừng hub: khôi
# phục kho pgBackRest vào container và volume tạm, so số dòng và checksum các bảng chính với database đang chạy, ghi
# biên bản <dir>/backups/drills/<ngày>.md rồi xoá container và volume tạm. Cần trống đĩa bằng cỡ database.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=deploy/backup-common.sh
. "$script_dir/backup-common.sh"
[ "$#" -eq 0 ] || fail "Cách dùng: deploy/drill.sh (HIVE_DRILL_TIMEOUT mặc định 3600 giây)."
[ -n "$(get_env HIVE_BACKUP_REPO "$env")" ] || fail "Chưa đặt HIVE_BACKUP_REPO: chưa có backup liên tục để diễn tập."
timeout=${HIVE_DRILL_TIMEOUT:-3600}
case "$timeout" in ''|*[!0-9]*) fail "HIVE_DRILL_TIMEOUT phải là số giây." ;; esac
pg=$(compose ps -q postgres)
[ -n "$pg" ] || fail "Không thấy container postgres đang chạy."
# Cùng image với bản đang chạy để bản khôi phục giống hệt lúc thật cần khôi phục.
image=$($docker inspect --format '{{.Image}}' "$pg")
acquire_lock
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name=$project-drill-$(printf '%s' "$stamp" | tr 'TZ' 'tz')
point=hive-drill-$stamp
env_tmp=
created=0
cleanup() {
  if [ "$created" -ne 0 ]; then
    $docker rm -f "$name" "$name-restore" >/dev/null 2>&1 || true
    $docker volume rm -f "$name" >/dev/null 2>&1 || true
  fi
  [ -z "$env_tmp" ] || rm -f -- "$env_tmp"
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

live() { compose exec -T postgres psql -U postgres -d hive -v ON_ERROR_STOP=1 -AtqX "$@"; }
drill() { $docker exec -i "$name" psql -U postgres -d hive -v ON_ERROR_STOP=1 -AtqX "$@"; }
# Bảng chính để so; bảng chưa có ở bản đang chạy (hub cũ) thì bỏ qua.
candidates='hive.orgs hive.org_members hive.projects hive.tasks hive.plans hive.runs hive.memories hive.docs
hive.doc_versions hive.machines hive.artifacts hive.audit_log auth."user"'
list=
for t in $candidates; do list="$list,'$t'"; done
tables=$(live -c "SELECT string_agg(t, ' ' ORDER BY n) FROM unnest(ARRAY[${list#,}]) WITH ORDINALITY AS u(t, n) WHERE to_regclass(t) IS NOT NULL")
[ -n "$tables" ] || fail "Database đang chạy không có bảng nào của Hive để so."
# Checksum không phụ thuộc thứ tự dòng trên đĩa; múi giờ cố định để timestamptz in ra giống nhau ở hai bên.
sums_sql() {
  printf "SET TIME ZONE 'UTC';\n"
  for t in $tables; do
    printf "SELECT '%s', count(*), coalesce(md5(string_agg(h, '' ORDER BY h)), '-') FROM (SELECT md5(x::text) AS h FROM %s x) s;\n" "$t" "$t"
  done
}

echo "Tính checksum và tạo điểm khôi phục $point…"
# Khoá SHARE chặn ghi vào các bảng chính (không chặn đọc) từ lúc tính checksum tới điểm khôi phục, để bản khôi phục
# về đúng điểm đó phải khớp từng dòng. Ghi vào các bảng này chờ trong vài giây đó.
snapshot=$({
  printf "SET lock_timeout = '30s';\nBEGIN;\nLOCK TABLE %s IN SHARE MODE;\n" "$(printf '%s' "$tables" | sed 's/ /, /g')"
  sums_sql
  printf "SELECT 'restore-point', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), pg_create_restore_point('%s');\nCOMMIT;\n" "$point"
} | live -f -)
expected=$(printf '%s\n' "$snapshot" | grep -v '^restore-point|')
point_at=$(printf '%s\n' "$snapshot" | sed -n 's/^restore-point|\([^|]*\)|.*/\1/p')
[ -n "$point_at" ] || fail "Không tạo được điểm khôi phục."
# check ép chuyển WAL và chờ đoạn WAL có điểm khôi phục lên kho.
compose exec -T postgres hive-pgbackrest check

env_tmp=$(mktemp "$dir/.drill-env.XXXXXX")
# Lấy biến kho từ container đang chạy (đã qua mặc định của compose). Bản tạm không archive: WAL của timeline mới sau
# khi promote không được lẫn vào kho của bản thật.
$docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$pg" |
  grep '^HIVE_BACKUP_' | grep -v '^HIVE_BACKUP_ARCHIVE=' >"$env_tmp" || true
echo HIVE_BACKUP_ARCHIVE=off >>"$env_tmp"

echo "Khôi phục vào container tạm $name…"
created=1
begin=$(date -u +%s)
$docker volume create "$name" >/dev/null
$docker run --rm --name "$name-restore" --env-file "$env_tmp" -v "$name:/var/lib/postgresql" \
  --entrypoint hive-pgbackrest "$image" restore --type=name "--target=$point" --target-action=promote
$docker run -d --name "$name" --env-file "$env_tmp" -v "$name:/var/lib/postgresql" "$image" >/dev/null
while :; do
  state=$(drill -c 'SELECT pg_is_in_recovery()' 2>/dev/null || echo '?')
  [ "$state" = f ] && break
  if [ "$($docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != true ]; then
    $docker logs --tail 50 "$name" >&2 || true
    fail "Postgres của bản tạm dừng trong lúc khôi phục; xem log ở trên."
  fi
  [ $(($(date -u +%s) - begin)) -lt "$timeout" ] || fail "Chưa khôi phục xong sau $timeout giây (trạng thái: $state)."
  sleep 5
done
elapsed=$(($(date -u +%s) - begin))
actual=$(sums_sql | drill -f -)

ok=1
[ "$expected" = "$actual" ] || ok=0
drills=$dir/backups/drills
mkdir -p "$drills"
chmod 700 "$dir/backups"
day=$(date -u +%Y-%m-%d)
report=$drills/$day.md
[ ! -e "$report" ] || report=$drills/$day-$stamp.md
{
  printf '# Diễn tập khôi phục %s\n\n' "$day"
  printf -- '- Project: `%s`\n' "$project"
  if [ "$ok" -eq 1 ]; then printf -- '- Kết quả: **Đạt**\n'; else printf -- '- Kết quả: **Không đạt**\n'; fi
  printf -- '- Khôi phục tới: %s (điểm khôi phục `%s`)\n' "$point_at" "$point"
  printf -- '- Thời gian khôi phục: %s giây (từ lúc tải bản backup tới khi database nhận ghi)\n' "$elapsed"
  printf -- '- Image: `%s`\n\n' "$image"
  printf '| Bảng | Số dòng (đang chạy) | Số dòng (bản khôi phục) | Checksum khớp |\n|---|---|---|---|\n'
  printf '%s\n' "$expected" | while IFS='|' read -r t count hash; do
    got=$(printf '%s\n' "$actual" | awk -F'|' -v t="$t" '$1 == t { print $2 "|" $3 }')
    match=không
    [ "$got" != "$count|$hash" ] || match=có
    printf '| `%s` | %s | %s | %s |\n' "$t" "$count" "${got%%|*}" "$match"
  done
} >"$report"
[ "$ok" -eq 1 ] || fail "Bản khôi phục không khớp database tại điểm khôi phục; xem $report."
echo "Diễn tập đạt: khôi phục trong $elapsed giây. Biên bản: $report."
