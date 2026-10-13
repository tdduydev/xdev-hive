#!/bin/sh
# Tải ảnh Docker chính thức (vd. node:24.21-bookworm-slim) từ registry đầu tiên trả lời, in ra tên ảnh đã tải.
# Runner của GitHub tải ẩn danh nên dễ chạm hạn mức của một registry (ECR "Data limit exceeded", Docker Hub 429):
# thử bản sao của Google trước, rồi ECR, rồi Docker Hub; mỗi nơi hai lần.
set -eu
name=${1:?Cách dùng: scripts/ci/pull-image.sh <ảnh:tag>}
for registry in mirror.gcr.io/library public.ecr.aws/docker/library docker.io/library; do
  for attempt in 1 2; do
    if docker pull --quiet "$registry/$name" >/dev/null 2>&1; then
      echo "$registry/$name"
      exit 0
    fi
    echo "Không tải được $registry/$name (lần $attempt)." >&2
    sleep $((attempt * 5))
  done
done
echo "Không registry nào trả $name." >&2
exit 1
