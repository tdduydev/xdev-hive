#!/usr/bin/env bash
# Quyết định job nào của CI phải chạy trên một PR, từ danh sách file PR đổi. Mỗi job một dòng `<tên>=true|false`
# (ghi vào $GITHUB_OUTPUT nếu có, và in ra màn hình).
#
# Cách dùng:
#   scripts/ci/changes.sh            lấy file đổi từ git (commit merge của PR: so với cha thứ nhất)
#   scripts/ci/changes.sh --stdin    đọc danh sách file từ stdin, mỗi dòng một đường dẫn (cho test)
#
# Nguyên tắc an toàn: chỉ bỏ job khi CHẮC CHẮN thay đổi không chạm tới nó. Không rõ (không đọc được diff, push, nhánh
# release, chạy tay) thì chạy hết. Đường dẫn lạ không nằm trong danh sách bỏ qua nào thì job vẫn chạy.
set -euo pipefail

OUTPUTS="web image smoke sandbox desktop worker worker_native"

# Tài liệu: *.md, specs/, docs/ (trừ docs/design-system: token màu và logo do web/desktop đọc lúc build và test).
is_docs() {
  case "$1" in
    *.md) return 0 ;;
    docs/design-system/*) return 1 ;;
    docs/* | specs/*) return 0 ;;
  esac
  return 1
}

# Việc không liên quan tới job Playwright (web dùng /rpc giả, không chạm worker, desktop, script phát hành).
skip_web() {
  case "$1" in
    worker/* | apps/desktop/* | scripts/release/* | scripts/install.* | deploy/* | VERSION) return 0 ;;
    packages/skill-pack/* | xdev-skills/* | scripts/e2e-* | e2e/sandbox/*) return 0 ;;
    .github/workflows/desktop.yml | .github/workflows/release.yml) return 0 ;;
  esac
  return 1
}

# Image Docker chỉ dựng hub và web (Dockerfile COPY . . rồi pnpm build).
skip_image() {
  case "$1" in
    worker/* | apps/desktop/* | scripts/release/* | scripts/install.* | VERSION) return 0 ;;
    .github/workflows/desktop.yml | .github/workflows/release.yml) return 0 ;;
  esac
  return 1
}

# E2E smoke và sandbox chạy hub + worker thật; app desktop và script phát hành không nằm trong luồng đó.
skip_smoke() {
  case "$1" in
    apps/desktop/* | scripts/release/* | scripts/install.* | VERSION) return 0 ;;
    .github/workflows/desktop.yml | .github/workflows/release.yml) return 0 ;;
  esac
  return 1
}

# Job chỉ chạy khi file nằm trong danh sách (khép kín, biết rõ đầu vào).
need_desktop() { # cùng đường dẫn với desktop.yml, thêm packages/ (giao diện app import từ đó)
  case "$1" in
    apps/desktop/* | worker/* | packages/* | docs/design-system/* | pnpm-lock.yaml | package.json) return 0 ;;
    pnpm-workspace.yaml | .nvmrc | .github/workflows/ci.yml | .github/workflows/desktop.yml | .github/actions/*) return 0 ;;
  esac
  return 1
}

need_worker() { # script cài và script phát hành được shellcheck/test trong job này; test Go đọc fixtures của contracts
  case "$1" in
    worker/* | packages/contracts/fixtures/* | scripts/install.* | scripts/release/* | scripts/ci/* | .github/workflows/ci.yml | .github/actions/*) return 0 ;;
  esac
  return 1
}

need_worker_native() { # macOS và Windows chỉ để thử Go và script cài trên hệ điều hành thật
  case "$1" in
    worker/* | packages/contracts/fixtures/* | scripts/install.* | .github/workflows/ci.yml | .github/actions/*) return 0 ;;
  esac
  return 1
}

# relevant <đầu ra> <file>: file này có làm job chạy không.
relevant() {
  local name="$1" file="$2"
  case "$name" in
    web) ! is_docs "$file" && ! skip_web "$file" ;;
    image) ! is_docs "$file" && ! skip_image "$file" ;;
    smoke | sandbox) ! is_docs "$file" && ! skip_smoke "$file" ;;
    desktop) ! is_docs "$file" && need_desktop "$file" ;;
    worker) ! is_docs "$file" && need_worker "$file" ;;
    worker_native) ! is_docs "$file" && need_worker_native "$file" ;;
  esac
}

emit() { # emit <đầu ra> <true|false>
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

emit_all() {
  local name
  for name in $OUTPUTS; do emit "$name" "$1"; done
}

changed_files() {
  # Checkout của PR là commit merge (cha thứ nhất là đầu nhánh đích); không có cha thì không biết gì để so.
  git rev-parse --verify -q HEAD^2 >/dev/null || return 1
  git diff --name-only HEAD^1 HEAD
}

# Không phải PR, hay PR vào nhánh phát hành: luôn chạy đủ.
if [ "${1:-}" != "--stdin" ]; then
  if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ] || [ "${GITHUB_BASE_REF:-}" = "release" ]; then
    echo "::notice::Chạy đủ mọi job (sự kiện ${GITHUB_EVENT_NAME:-?}, nhánh đích ${GITHUB_BASE_REF:-không có})."
    emit_all true
    exit 0
  fi
  if ! files="$(changed_files)" || [ -z "$files" ]; then
    echo "::notice::Không đọc được danh sách file đổi: chạy đủ mọi job."
    emit_all true
    exit 0
  fi
else
  files="$(cat)"
  [ -n "$files" ] || { emit_all true; exit 0; }
fi

echo "File PR đổi:"
while IFS= read -r file; do echo "  $file"; done <<< "$files"
for name in $OUTPUTS; do
  result=false
  while IFS= read -r file; do
    if relevant "$name" "$file"; then
      result=true
      break
    fi
  done <<< "$files"
  emit "$name" "$result"
done
