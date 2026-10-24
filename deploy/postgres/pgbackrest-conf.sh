#!/bin/sh
# Ghi /etc/pgbackrest/pgbackrest.conf từ biến HIVE_BACKUP_* của compose; chạy bằng root. Cấu hình nằm trong container,
# không trong volume, nên mỗi lần khởi động (và mỗi container `compose run`) ghi lại theo .env đang dùng.
set -eu
conf=/etc/pgbackrest/pgbackrest.conf
fail() { echo "hive-pgbackrest: $*" >&2; exit 1; }
# Giá trị có xuống dòng sẽ chèn được tuỳ chọn lạ vào file cấu hình.
value() {
  case "$2" in *'
'*) fail "$1 không được có xuống dòng." ;; esac
  printf '%s\n' "$2"
}

repo=$(value HIVE_BACKUP_REPO "${HIVE_BACKUP_REPO:-}")
if [ -z "$repo" ]; then
  rm -f "$conf"
  exit 0
fi
# Kho ở máy khác (S3 của nhà cung cấp, máy SFTP dùng chung): ai đọc được kho không được đọc được database.
cipher=$(value HIVE_BACKUP_CIPHER_PASS "${HIVE_BACKUP_CIPHER_PASS:-}")
[ -n "$cipher" ] || fail "Thiếu HIVE_BACKUP_CIPHER_PASS; kho backup phải được mã hoá."
days=${HIVE_BACKUP_RETENTION_DAYS:-14}
case "$days" in ''|0*|*[!0-9]*) fail "HIVE_BACKUP_RETENTION_DAYS phải là số ngày nguyên dương." ;; esac
dir=$(dirname "$conf")
umask 077

repo_conf() {
  case "$repo" in
    s3://*)
      rest=${repo#s3://}
      bucket=${rest%%/*}
      path=/
      case "$rest" in */*) path=/${rest#*/} ;; esac
      [ -n "$bucket" ] || fail "HIVE_BACKUP_REPO thiếu tên bucket: s3://<bucket>/<đường dẫn>."
      endpoint=$(value HIVE_BACKUP_S3_ENDPOINT "${HIVE_BACKUP_S3_ENDPOINT:-}")
      key=$(value HIVE_BACKUP_S3_KEY "${HIVE_BACKUP_S3_KEY:-}")
      secret=$(value HIVE_BACKUP_S3_KEY_SECRET "${HIVE_BACKUP_S3_KEY_SECRET:-}")
      [ -n "$endpoint" ] && [ -n "$key" ] && [ -n "$secret" ] ||
        fail "Kho S3 cần HIVE_BACKUP_S3_ENDPOINT, HIVE_BACKUP_S3_KEY và HIVE_BACKUP_S3_KEY_SECRET."
      style=${HIVE_BACKUP_S3_URI_STYLE:-host}
      case "$style" in host|path) ;; *) fail "HIVE_BACKUP_S3_URI_STYLE chỉ nhận host hoặc path." ;; esac
      region=$(value HIVE_BACKUP_S3_REGION "${HIVE_BACKUP_S3_REGION:-us-east-1}")
      printf 'repo1-type=s3\nrepo1-path=%s\nrepo1-s3-bucket=%s\nrepo1-s3-region=%s\nrepo1-s3-uri-style=%s\n' \
        "$path" "$bucket" "$region" "$style"
      # MinIO trong mạng nội bộ hay chạy cổng riêng: nhận <máy>:<cổng>.
      case "$endpoint" in
        *:*) printf 'repo1-s3-endpoint=%s\nrepo1-storage-port=%s\n' "${endpoint%:*}" "${endpoint##*:}" ;;
        *) printf 'repo1-s3-endpoint=%s\n' "$endpoint" ;;
      esac
      printf 'repo1-s3-key=%s\nrepo1-s3-key-secret=%s\n' "$key" "$secret"
      ;;
    sftp://*)
      rest=${repo#sftp://}
      authority=${rest%%/*}
      case "$rest" in */?*) path=/${rest#*/} ;; *) fail "HIVE_BACKUP_REPO thiếu đường dẫn: sftp://<user>@<máy>/<đường dẫn>." ;; esac
      case "$authority" in ?*@?*) ;; *) fail "HIVE_BACKUP_REPO thiếu user: sftp://<user>@<máy>/<đường dẫn>." ;; esac
      user=${authority%%@*}
      host=${authority#*@}
      port=22
      case "$host" in *:*) port=${host##*:}; host=${host%:*} ;; esac
      case "$port" in ''|*[!0-9]*) fail "Cổng SFTP không hợp lệ: $port." ;; esac
      [ -n "${HIVE_BACKUP_SFTP_KEY:-}" ] || fail "Kho SFTP cần HIVE_BACKUP_SFTP_KEY (khoá riêng, base64 một dòng)."
      # Không có known_hosts thì không biết đang đẩy WAL tới đúng máy hay máy giả mạo.
      known=$(value HIVE_BACKUP_SFTP_KNOWN_HOSTS "${HIVE_BACKUP_SFTP_KNOWN_HOSTS:-}")
      [ -n "$known" ] || fail "Kho SFTP cần HIVE_BACKUP_SFTP_KNOWN_HOSTS (dòng của máy kho trong known_hosts)."
      printf '%s' "$HIVE_BACKUP_SFTP_KEY" | base64 -d >"$dir/sftp_key" || fail "HIVE_BACKUP_SFTP_KEY không phải base64."
      printf '%s\n' "$known" >"$dir/known_hosts"
      chown postgres:postgres "$dir/sftp_key" "$dir/known_hosts"
      printf 'repo1-type=sftp\nrepo1-path=%s\nrepo1-sftp-host=%s\nrepo1-sftp-host-port=%s\nrepo1-sftp-host-user=%s\n' \
        "$path" "$host" "$port" "$user"
      printf 'repo1-sftp-private-key-file=%s\nrepo1-sftp-known-host=%s\nrepo1-sftp-host-key-check-type=strict\n' \
        "$dir/sftp_key" "$dir/known_hosts"
      ;;
    *) fail "HIVE_BACKUP_REPO phải là s3://<bucket>/<đường dẫn> hoặc sftp://<user>@<máy>[:<cổng>]/<đường dẫn>." ;;
  esac
}

tmp=$(mktemp "$dir/.pgbackrest.conf.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
{
  printf '[global]\n'
  repo_conf
  # Giữ đủ backup đầy đủ để khôi phục về bất kỳ lúc nào trong $days ngày gần nhất (FR-040); WAL giữ theo các bản đó.
  printf 'repo1-retention-full-type=time\nrepo1-retention-full=%s\n' "$days"
  printf 'repo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=%s\n' "$cipher"
  # Log ra stderr của container (docker compose logs postgres), không giữ file log trong container.
  printf 'start-fast=y\nlog-level-console=info\nlog-level-file=off\n'
  printf '\n[hive]\npg1-path=%s\n' "${PGDATA:?}"
} >"$tmp"
chown postgres:postgres "$tmp"
mv "$tmp" "$conf"
