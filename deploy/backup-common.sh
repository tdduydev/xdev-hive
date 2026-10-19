#!/bin/sh
# Các script chỉ đọc .env như dữ liệu, không source file có chứa secret thành mã shell.
fail() { echo "$*" >&2; exit 1; }
get_env() {
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$2" |
    sed -e 's/\r$//' -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/'
}

# shellcheck disable=SC2154 # Script gọi đã xác định script_dir trước khi source file này.
src=$(CDPATH='' cd -- "$script_dir/.." && pwd)
dir=$(dirname "$src")
env=$dir/.env
[ -f "$env" ] || fail "Không thấy $env; script dùng bố cục <dir>/.env và <dir>/src của deploy/remote.sh."
project=$(get_env HIVE_COMPOSE_PROJECT "$env")
case "$project" in
  ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail "HIVE_COMPOSE_PROJECT trong .env không hợp lệ." ;;
esac
[ -n "$(get_env HIVE_MASTER_KEY "$env")" ] || fail "Thiếu HIVE_MASTER_KEY trong .env; không thể bảo vệ secret trong bản sao lưu."
docker=${HIVE_REMOTE_DOCKER:-docker}
# HIVE_REMOTE_DOCKER có thể là "sudo docker", cùng quy ước với remote.sh.
compose() { $docker compose -p "$project" --env-file "$env" -f "$src/deploy/compose.yaml" "$@"; }

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
# Bản sao lưu không chứa .env: ai có bản sao lưu cùng khoá chủ là giải mã được mọi secret. meta thay chỗ đó, đủ để
# restore kiểm .env đang dùng đúng project và đúng khoá với bản dump. Khoá là 32 byte ngẫu nhiên, sha256 không lộ khoá.
# Hub coi là cùng một khoá dù .env viết có ngoặc, thừa khoảng trắng, có chú thích cuối dòng, thiếu "=" đệm hay dùng bảng
# chữ base64 URL-safe, nên băm chuỗi đã chuẩn hoá để khôi phục sau sự cố không báo lệch khoá oan. docs/self-hosting.md
# in đúng lệnh này để quản trị tự kiểm .env đang cất; sửa ở đây thì sửa cả ở đó.
key_fingerprint() {
  sed -n 's/^HIVE_MASTER_KEY=//p' "$1" | tail -n 1 | sed 's/#.*//' | tr -d "[:space:]\"'=" | tr '_-' '/+' | checksum |
    cut -d ' ' -f 1
}
backup_meta() {
  printf 'HIVE_COMPOSE_PROJECT=%s\nHIVE_MASTER_KEY_SHA256=%s\n' "$(get_env HIVE_COMPOSE_PROJECT "$1")" "$(key_fingerprint "$1")"
}
lock=$dir/.backup-restore.lock
acquire_lock() {
  umask 077
  mkdir "$lock" 2>/dev/null || fail "Backup/restore khác đang chạy (hoặc khoá còn sót): $lock."
}
wait_healthy() {
  i=0
  while :; do
    id=$(compose ps -q hub)
    status=$($docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo '?')
    [ "$status" = healthy ] && return 0
    i=$((i + 1))
    [ "$i" -lt 36 ] || fail "Hub chưa healthy sau 3 phút (trạng thái: $status); xem docker compose logs hub."
    sleep 5
  done
}
