#!/bin/sh
# Chạy trên máy chủ: <dir>/src/deploy/backup.sh.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
# shellcheck source=deploy/backup-common.sh
. "$script_dir/backup-common.sh"
[ "$#" -eq 0 ] || fail "Cách dùng: deploy/backup.sh (HIVE_BACKUP_KEEP mặc định 14)."
keep=${HIVE_BACKUP_KEEP:-$(get_env HIVE_BACKUP_KEEP "$env")}
keep=${keep:-14}
case "$keep" in ''|*[!0-9]*) fail "HIVE_BACKUP_KEEP phải là số nguyên dương." ;; esac
[ "$keep" -gt 0 ] || fail "HIVE_BACKUP_KEEP phải lớn hơn 0."
acquire_lock
pending=
cleanup() {
  [ -z "$pending" ] || rm -rf -- "$pending"
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
root=$dir/backups
mkdir -p "$root"
chmod 700 "$root"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$root/$stamp
[ ! -e "$backup" ] || fail "Đã có bản sao lưu ở $backup; thử lại sau một giây."
pending=$(mktemp -d "$root/.pending.XXXXXX")
cp "$env" "$pending/.env"
chmod 600 "$pending/.env"
echo "Sao lưu database hive của project ${project}…"
compose exec -T postgres pg_dump -U postgres -Fc hive >"$pending/hive.dump"
chmod 600 "$pending/hive.dump"
compose exec -T postgres pg_restore --list <"$pending/hive.dump" >/dev/null
cmp -s "$env" "$pending/.env" || fail ".env đã thay đổi khi sao lưu; giữ nguyên các bản sao lưu cũ."
(cd "$pending" && checksum hive.dump .env >SHA256SUMS)
chmod 600 "$pending/SHA256SUMS"
mv "$pending" "$backup"
pending=

# Chỉ tính thư mục hoàn tất có đúng tên timestamp của script; không đụng file người dùng hay bản đang ghi.
count=0
for name in $(find "$root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort -r); do
  case "$name" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z)
      [ -f "$root/$name/SHA256SUMS" ] || continue
      count=$((count + 1))
      [ "$count" -le "$keep" ] || rm -rf -- "${root:?}/$name"
      ;;
  esac
done
echo "Đã sao lưu: $backup (giữ $keep bản mới nhất)."
