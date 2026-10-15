#!/usr/bin/env bash
# In phiên bản phát hành kế tiếp (x.y.z, không có chữ v) cho luồng nhánh `release`.
#
# Cách dùng: scripts/release/version.sh [file-version]   (chạy trong repo; danh sách tag lấy từ `git tag`)
#
# File VERSION là mốc sàn chứ không phải bộ đếm: tăng patch không cần sửa file, vì phát hành rơi vào số đã có tag thì tự
# nhảy sang patch kế tiếp.
#   VERSION > tag mới nhất  -> VERSION (cố ý tăng minor/major)
#   VERSION <= tag mới nhất -> tag mới nhất, patch + 1
#   không có file VERSION   -> tag mới nhất, patch + 1 (0.0.1 khi chưa có tag nào)
set -euo pipefail

file="${1:-VERSION}"
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# So hai chuỗi x.y.z theo số (0.2.10 > 0.2.9): in -1, 0 hoặc 1.
compare() {
  local a b i
  IFS=. read -ra a <<< "$1"
  IFS=. read -ra b <<< "$2"
  for i in 0 1 2; do
    if [ "${a[$i]}" -gt "${b[$i]}" ]; then echo 1; return; fi
    if [ "${a[$i]}" -lt "${b[$i]}" ]; then echo -1; return; fi
  done
  echo 0
}

# Chỉ tag vX.Y.Z thuần mới tính: tag pre-release hay tag lạ không được đẩy mốc sàn lên.
newest=""
while IFS= read -r tag; do
  v="${tag#v}"
  [[ "$v" =~ $semver ]] || continue
  if [ -z "$newest" ] || [ "$(compare "$v" "$newest")" = 1 ]; then newest="$v"; fi
done < <(git tag --list 'v[0-9]*')

declared=""
if [ -f "$file" ]; then
  declared="$(tr -d '[:space:]' < "$file")"
  declared="${declared#v}"
  if ! [[ "$declared" =~ $semver ]]; then
    echo "::error::$file phải chứa phiên bản dạng 0.3.0 (đang là '$declared')." >&2
    exit 1
  fi
fi

if [ -n "$declared" ] && { [ -z "$newest" ] || [ "$(compare "$declared" "$newest")" = 1 ]; }; then
  echo "$declared"
  exit 0
fi

base="${newest:-0.0.0}"
IFS=. read -r major minor patch <<< "$base"
echo "$major.$minor.$((patch + 1))"
