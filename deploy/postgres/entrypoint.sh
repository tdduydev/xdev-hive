#!/bin/sh
# Đặt HIVE_BACKUP_REPO thì đẩy WAL liên tục lên kho pgBackRest, rồi chạy entrypoint gốc của image Postgres. Tuỳ chọn
# archive nằm trên dòng lệnh, không trong postgresql.conf: bỏ HIVE_BACKUP_REPO là tắt hẳn ở lần khởi động sau.
set -eu
if [ -n "${HIVE_BACKUP_REPO:-}" ] && [ "${1:-}" = postgres ] && [ "$(id -u)" = 0 ]; then
  # Cần cả khi không archive: bản đã khôi phục đọc WAL từ kho qua restore_command.
  hive-pgbackrest-conf
  # Diễn tập dùng chung kho: bản tạm không được đẩy WAL của timeline mới vào kho của bản thật.
  if [ "${HIVE_BACKUP_ARCHIVE:-on}" = on ]; then
    # archive_timeout giới hạn dữ liệu có thể mất lúc ít ghi: WAL chưa đầy cũng được đẩy sau 5 phút.
    set -- "$@" -c archive_mode=on -c 'archive_command=pgbackrest --stanza=hive archive-push %p' -c archive_timeout=300
  fi
fi
exec docker-entrypoint.sh "$@"
