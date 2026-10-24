#!/bin/sh
# Khôi phục database về một thời điểm từ kho pgBackRest (ADR 0035). Chạy trên máy chủ: <dir>/src/deploy/pitr-restore.sh.
# Khác restore.sh (một bản pg_dump): khôi phục cả cụm Postgres, gồm mọi giao dịch đã commit trước thời điểm đó.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=deploy/backup-common.sh
. "$script_dir/backup-common.sh"
yes=0
target=
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --*) fail "Tuỳ chọn không hợp lệ: $arg" ;;
    *) [ -z "$target" ] || fail "Chỉ nhận một thời điểm."; target=$arg ;;
  esac
done
[ -n "$target" ] || fail "Cách dùng: deploy/pitr-restore.sh '<thời điểm, vd. 2026-10-24T03:00:00Z>' [--yes]."
# pgBackRest nhận "YYYY-MM-DD HH:MM:SS[.ms]+HH[MM]"; nhận thêm dạng ISO (…T…Z, +07:00) hay chép từ log. Bắt buộc có
# múi giờ: thiếu thì Postgres hiểu theo múi giờ của máy chủ, khôi phục lệch vài giờ mà không ai hay.
target=$(printf '%s\n' "$target" | sed -e 's/^\([0-9-]*\)T/\1 /' -e 's/Z$/+00/' -e 's/\([+-][0-9][0-9]\):\([0-9][0-9]\)$/\1\2/')
printf '%s\n' "$target" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}([0-9]{2})?$' ||
  fail "Thời điểm không hợp lệ: cần dạng 2026-10-24T03:00:00Z hoặc '2026-10-24 10:00:00+07'."
[ -n "$(get_env HIVE_BACKUP_REPO "$env")" ] ||
  fail "Chưa đặt HIVE_BACKUP_REPO nên không có backup liên tục; dùng deploy/restore.sh với bản pg_dump."
admin_password=$(get_env HIVE_DB_ADMIN_PASSWORD "$env")
[ -n "$admin_password" ] || fail "Thiếu HIVE_DB_ADMIN_PASSWORD trong $env."
acquire_lock
stopped=0
cleanup() {
  if [ "$stopped" -ne 0 ]; then
    compose stop hub hub-jobs >/dev/null 2>&1 || true
    echo "Khôi phục chưa hoàn tất; hub đang dừng. Xem docker compose logs postgres, sửa lỗi rồi chạy lại pitr-restore.sh." >&2
  fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
compose exec -T postgres hive-pgbackrest info >/dev/null || fail "Không đọc được kho backup; database chưa thay đổi."
if [ "$yes" -eq 0 ]; then
  printf 'Khôi phục database của project %s về %s? Mọi thay đổi sau thời điểm này sẽ mất. [y/N] ' "$project" "$target" >&2
  answer=
  read -r answer || true
  case "$answer" in y|Y|yes) ;; *) fail "Đã huỷ; database chưa thay đổi." ;; esac
fi

echo "Dừng hub và Postgres của project ${project}…"
compose stop hub hub-jobs
stopped=1
compose stop postgres
# --delta chỉ ghi lại file khác bản backup, nhanh hơn xoá PGDATA rồi tải hết. Container tạm dùng đúng volume của
# service postgres; Postgres đã dừng nên pgBackRest không đụng cụm đang chạy.
compose run --rm --no-deps -T --entrypoint hive-pgbackrest postgres \
  restore --delta --type=time "--target=$target" --target-action=promote
compose start postgres
echo "Đang phát lại WAL tới $target…"
pg=$(compose ps -aq postgres)
restarts() { $docker inspect --format '{{.RestartCount}}' "$pg" 2>/dev/null || echo '?'; }
started_restarts=$(restarts)
i=0
while :; do
  state=$(compose exec -T postgres psql -U postgres -d hive -Atqc 'SELECT pg_is_in_recovery()' 2>/dev/null || echo '?')
  [ "$state" = f ] && break
  # Thời điểm sau WAL cuối cùng của kho thì Postgres dừng hẳn và compose khởi động lại mãi; báo ngay thay vì chờ 1 giờ.
  [ "$(restarts)" = "$started_restarts" ] || fail "Postgres dừng trong lúc khôi phục (thời điểm có thể sau WAL cuối của kho); xem docker compose logs postgres."
  i=$((i + 1))
  [ "$i" -lt 720 ] || fail "Postgres chưa khôi phục xong sau 1 giờ (trạng thái: $state); xem docker compose logs postgres."
  sleep 5
done
# Mốc mới để worker gửi lại việc hub nhận sau $target (specs/027 R7).
{
  printf 'BEGIN;\n'
  db_epoch_sql "$target"
  printf 'COMMIT;\n'
} | compose exec -T postgres psql -U postgres -d hive -v ON_ERROR_STOP=1 >/dev/null
# Mật khẩu role postgres cũng về như lúc $target; đồng bộ với .env trước khi hub bootstrap các role còn lại.
escaped_password=$(printf '%s' "$admin_password" | sed "s/'/''/g")
printf "SET standard_conforming_strings = on; ALTER ROLE postgres PASSWORD '%s';\n" "$escaped_password" |
  compose exec -T postgres psql -U postgres -d hive -v ON_ERROR_STOP=1 >/dev/null
# Giữ đúng container và version đang chạy, không build hay nâng cấp code khi khôi phục.
compose start hub
wait_healthy
compose start hub-jobs
stopped=0
echo "Đã khôi phục về $target; hub healthy. Chạy deploy/backup.sh để có bản backup trên timeline mới."
