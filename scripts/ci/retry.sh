#!/bin/sh
# Chạy lại lệnh hạ tầng (apt, tải khoá, cài trình duyệt) khi mạng của runner chập chờn: CI đỏ vì kho apt trả lỗi một lần
# không nói gì về code. Không dùng cho test: test hỏng thì phải sửa test.
set -u
tries=${1:?Cách dùng: scripts/ci/retry.sh <số lần> <lệnh> [tham số...]}
shift
n=1
while :; do
  "$@" && exit 0
  status=$?
  if [ "$n" -ge "$tries" ]; then
    echo "Lệnh vẫn lỗi sau $tries lần: $*" >&2
    exit "$status"
  fi
  echo "Lệnh lỗi (mã $status, lần $n/$tries), thử lại sau $((n * 10)) giây: $*" >&2
  sleep $((n * 10))
  n=$((n + 1))
done
