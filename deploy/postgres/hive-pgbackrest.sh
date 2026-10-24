#!/bin/sh
# pgBackRest với stanza của Hive. `docker compose exec/run` chạy bằng root: ghi lại cấu hình từ biến môi trường rồi chạy
# bằng user postgres, chủ của PGDATA.
set -eu
[ -n "${HIVE_BACKUP_REPO:-}" ] || { echo "hive-pgbackrest: chưa đặt HIVE_BACKUP_REPO." >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then
  hive-pgbackrest-conf
  if [ "${1:-}" = restore ]; then
    # Volume mới của diễn tập chưa có PGDATA; user postgres không tự tạo được thư mục cha.
    mkdir -p "$PGDATA"
    chown postgres:postgres "$(dirname "$PGDATA")" "$PGDATA"
    chmod 700 "$PGDATA"
  fi
  exec gosu postgres pgbackrest --stanza=hive "$@"
fi
exec pgbackrest --stanza=hive "$@"
