#!/bin/sh
# Sao lưu ngay; --cron cài thêm lịch chạy bằng user SSH, không gửi .env về máy dev.
set -eu
target=${1:?Cách dùng: deploy/remote-backup.sh <user@máy-chủ> [--cron "0 3 * * *"]}
shift
cron=
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --cron ] || { echo 'Cách dùng: deploy/remote-backup.sh <user@máy-chủ> [--cron "0 3 * * *"]' >&2; exit 1; }
  cron=$2
  # Chỉ nhận năm trường số/ký tự lịch; không cho chèn lệnh hay xuống dòng vào crontab.
  printf '%s\n' "$cron" | LC_ALL=C grep -Eq '^([0-9*/,-]+[[:blank:]]+){4}[0-9*/,-]+$' || { echo 'Lịch cron cần đúng năm trường phút, giờ, ngày, tháng, thứ.' >&2; exit 1; }
fi
dir=${HIVE_REMOTE_DIR:-/opt/xdev-hive}
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
args="$(q "$dir") $(q "${HIVE_REMOTE_DOCKER:-docker}") $(q "$cron")"
# shellcheck disable=SC2029 # Mỗi tham số được quote để shell trên máy chủ giữ nguyên giá trị.
ssh "$target" "sh -s -- $args" <<'REMOTE'
set -eu
dir=$1 docker=$2 cron=$3
case "$dir$docker" in
  *'%'*|*'
'*) echo 'Đường dẫn/lệnh Docker không được chứa % hoặc xuống dòng khi dùng cron.' >&2; exit 1 ;;
esac
cd "$dir/src"
HIVE_REMOTE_DOCKER=$docker sh deploy/backup.sh
[ -n "$cron" ] || exit 0
command -v crontab >/dev/null 2>&1 || { echo 'Máy chủ chưa có crontab.' >&2; exit 1; }
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
umask 077
tmp=$(mktemp "$dir/.cron.XXXXXX")
trap 'rm -f "$tmp" "$tmp.old"' EXIT
trap 'exit 1' HUP INT TERM
# Không ghi đè lịch hiện có nếu crontab -l lỗi vì lý do khác với chưa có crontab.
if ! LC_ALL=C crontab -l >"$tmp.old" 2>"$tmp"; then
  grep -qi 'no crontab for' "$tmp" || { cat "$tmp" >&2; exit 1; }
fi
marker="# xdev-hive-backup: $dir"
HIVE_CRON_MARKER=$marker awk 'BEGIN { marker = ENVIRON["HIVE_CRON_MARKER"] }
  substr($0, length($0) - length(marker) + 1) != marker' "$tmp.old" >"$tmp"
touch "$dir/backups/cron.log"
chmod 600 "$dir/backups/cron.log"
printf '%s umask 077; cd %s && HIVE_REMOTE_DOCKER=%s /bin/sh deploy/backup.sh >>%s 2>&1 %s\n' \
  "$cron" "$(q "$dir/src")" "$(q "$docker")" "$(q "$dir/backups/cron.log")" "$marker" >>"$tmp"
crontab "$tmp"
echo "Đã cài cron backup: $cron (múi giờ của máy chủ)."
REMOTE
