#!/bin/sh
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=deploy/backup-common.sh
. "$script_dir/backup-common.sh"
yes=0
backup=
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --*) fail "Tuỳ chọn không hợp lệ: $arg" ;;
    *) [ -z "$backup" ] || fail "Chỉ nhận một thư mục bản sao lưu."; backup=$arg ;;
  esac
done
[ -n "$backup" ] && [ -d "$backup" ] || fail "Cách dùng: deploy/restore.sh <thư mục bản sao lưu> [--yes]."
backup=$(CDPATH='' cd -- "$backup" && pwd)
for file in hive.dump SHA256SUMS; do
  [ -s "$backup/$file" ] || fail "Bản sao lưu thiếu $file."
done
# Bản sao lưu mới có meta thay cho .env và dùng .env đang có trên máy chủ. Bản cũ còn .env thì khôi phục như trước.
if [ -s "$backup/meta" ]; then saved=meta; elif [ -s "$backup/.env" ]; then saved=.env; else
  fail "Bản sao lưu thiếu meta (bản sao lưu cũ thì thiếu .env)."
fi
[ "$(get_env HIVE_COMPOSE_PROJECT "$backup/$saved")" = "$project" ] || fail "Bản sao lưu thuộc compose project khác; không khôi phục nhầm hệ thống."
if [ "$saved" = meta ]; then
  # Secret trong dump chỉ giải mã được bằng đúng khoá lúc sao lưu; khôi phục với khoá khác là mất mọi secret đã lưu.
  key_sha=$(get_env HIVE_MASTER_KEY_SHA256 "$backup/meta")
  [ -n "$key_sha" ] || fail "meta của bản sao lưu thiếu HIVE_MASTER_KEY_SHA256."
  [ "$key_sha" = "$(key_fingerprint "$env")" ] ||
    fail "HIVE_MASTER_KEY trong $env khác khoá lúc sao lưu; database chưa thay đổi. Cần .env gốc: chép vào $env rồi chạy lại."
  source_env=$env
else
  [ -n "$(get_env HIVE_MASTER_KEY "$backup/.env")" ] || fail "Bản sao lưu thiếu HIVE_MASTER_KEY."
  source_env=$backup/.env
fi
admin_password=$(get_env HIVE_DB_ADMIN_PASSWORD "$source_env")
[ -n "$admin_password" ] || fail "Thiếu HIVE_DB_ADMIN_PASSWORD trong $source_env."
acquire_lock
stopped=0
env_tmp=
sql_tmp=
cleanup() {
  [ -z "$env_tmp" ] || rm -f -- "$env_tmp"
  [ -z "$sql_tmp" ] || rm -f -- "$sql_tmp"
  if [ "$stopped" -ne 0 ]; then
    # Hub vừa tái tạo có thể đã ghi dữ liệu dù chưa healthy; dừng lại khi bất kỳ bước khôi phục nào lỗi.
    compose stop hub >/dev/null 2>&1 || true
    echo "Khôi phục chưa hoàn tất; đã yêu cầu dừng hub. Kiểm tra trạng thái, sửa lỗi rồi chạy lại restore.sh với bản sao lưu này." >&2
  fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
(cd "$backup" && checksum hive.dump "$saved" | cmp -s - SHA256SUMS) || fail "Checksum không khớp; không dừng hub hay sửa database."
compose exec -T postgres pg_restore --list <"$backup/hive.dump" >/dev/null
# pg_dump không chứa role toàn cụm. Giữ role, ownership và ACL của bản triển khai đã bootstrap.
roles=$(compose exec -T postgres psql -U postgres -d hive -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('hive_owner', 'hive_app', 'hive_auth', 'hive_jobs')")
[ "$roles" = 4 ] || fail "Thiếu role của Hive; cần bootstrap bản triển khai trước khi restore."
if [ "$saved" = .env ] && ! cmp -s "$env" "$backup/.env"; then
  if [ "$yes" -eq 0 ]; then
    printf 'Ghi đè %s bằng .env của bản sao lưu (gồm khoá chủ và secret)? [y/N] ' "$env" >&2
    answer=
    read -r answer || true
    case "$answer" in y|Y|yes) ;; *) fail "Đã huỷ; database và .env chưa thay đổi." ;; esac
  fi
fi

# Giữ version của image đang chạy khi tái tạo hub để nạp .env, không build hay nâng cấp code khi restore.
id=$(compose ps -aq hub)
[ -n "$id" ] || fail "Không thấy container hub của bản triển khai."
HIVE_VERSION=$($docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n 's/^HIVE_VERSION=//p')
export HIVE_VERSION
sql_tmp=$(mktemp "$dir/.restore.XXXXXX")
compose exec -T postgres pg_restore --clean --if-exists --file=- <"$backup/hive.dump" >"$sql_tmp"
echo "Dừng hub và khôi phục database hive của project ${project}…"
compose stop hub
stopped=1
# PostgreSQL 18 không clean được constraint kế thừa của partition pg-boss còn tồn tại. Xoá schema hàng đợi trước
# trong cùng transaction với SQL của pg_restore, để lỗi vẫn rollback cả dữ liệu và schema. Không DROP DATABASE/ROLE.
{
  printf 'BEGIN;\nSET LOCAL client_min_messages = warning;\nDROP SCHEMA IF EXISTS pgboss CASCADE;\n'
  cat "$sql_tmp"
  printf '\nCOMMIT;\n'
} | compose exec -T postgres psql -U postgres -d hive -v ON_ERROR_STOP=1 >/dev/null
# Role postgres nằm ngoài dump. Đồng bộ mật khẩu với .env trước khi hub bootstrap các role còn lại.
escaped_password=$(printf '%s' "$admin_password" | sed "s/'/''/g")
printf "SET standard_conforming_strings = on; ALTER ROLE postgres PASSWORD '%s';\n" "$escaped_password" |
  compose exec -T postgres psql -U postgres -d hive -v ON_ERROR_STOP=1 >/dev/null
if [ "$saved" = .env ] && ! cmp -s "$env" "$backup/.env"; then
  env_tmp=$(mktemp "$dir/.env.restore.XXXXXX")
  cp "$backup/.env" "$env_tmp"
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$env"
  env_tmp=
fi
chmod 600 "$env"
compose up -d --no-build --no-deps --force-recreate hub
wait_healthy
stopped=0
echo "Đã khôi phục $backup; hub healthy."
