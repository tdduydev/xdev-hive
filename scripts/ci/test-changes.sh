#!/usr/bin/env bash
# Kiểm scripts/ci/changes.sh: mỗi ca đưa vào một danh sách file và so với đầu ra mong đợi.
# Cách dùng: scripts/ci/test-changes.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
failed=0

# check <tên ca> <đầu ra mong đợi: web image smoke sandbox desktop worker worker_native, t/f> <file>...
check() {
  local name="$1" want="$2" got out
  shift 2
  want="${want// /}"
  out="$(printf '%s\n' "$@" | "$here/changes.sh" --stdin | grep -E '^[a-z_]+=(true|false)$' | tr '\n' ' ')"
  # Chuẩn hoá thành chuỗi t/f theo thứ tự cố định.
  got=""
  for key in web image smoke sandbox desktop worker worker_native; do
    if [[ "$out" == *"$key=true "* ]]; then got="${got}t"; else got="${got}f"; fi
  done
  if [ "$want" = "$got" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    printf '  expected: %s\n  actual:   %s\n  (thứ tự: web image smoke sandbox desktop worker worker_native)\n' "$want" "$got"
    failed=1
  fi
}

#                                         web image smoke sandbox desktop worker native
check "chỉ tài liệu"                      "f f f f f f f" README.md docs/architecture.md specs/001/spec.md docs/adr/0001.md
check "md ở thư mục code"                 "f f f f f f f" apps/web/README.md worker/README.md
check "design-system md"                  "f f f f f f f" docs/design-system/xdev-hive/MASTER.md
check "token màu"                         "t t t t t f f" docs/design-system/tokens.json
check "logo của desktop và web"           "t t t t t f f" docs/design-system/assets/logos/hive.svg
check "màn web"                           "t t t t f f f" apps/web/src/routes/home.tsx
check "hub"                               "t t t t f f f" apps/hub/src/modules/task/router.ts
check "contracts"                         "t t t t t f f" packages/contracts/src/index.ts
check "gói skill-pack (chỉ hub dùng)"     "f t t t t f f" packages/skill-pack/src/index.ts
check "worker Go"                         "f f t t t t t" worker/internal/update/update.go
check "script cài Windows"                "f f f f f t t" scripts/install.ps1
check "script phát hành"                  "f f f f f t f" scripts/release/version.sh
check "app desktop"                       "f f f f t f f" apps/desktop/src/main.tsx
check "workflow desktop"                  "f f f f t f f" .github/workflows/desktop.yml
check "workflow ci"                       "t t t t t t t" .github/workflows/ci.yml
check "script ci"                         "t t t t f t f" scripts/ci/changes.sh
check "khoá phụ thuộc"                    "t t t t t f f" pnpm-lock.yaml
check "đường dẫn lạ"                      "t t t t f f f" some/new/thing.txt
check "tài liệu lẫn code web"             "t t t t f f f" README.md apps/web/src/app.tsx
check "tài liệu lẫn worker"               "f f t t t t t" docs/ci.md worker/go.mod
check "danh sách rỗng chạy đủ"            "t t t t t t t"

# Đường git: commit merge như checkout của PR (cha thứ nhất là nhánh đích, cha thứ hai là nhánh PR).
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git init -q -b main "$work/repo"
(
  cd "$work/repo"
  git config user.name test
  git config user.email test@example.com
  git config commit.gpgsign false
  mkdir -p apps/web docs
  echo a > apps/web/a.ts
  git add . && git commit -q -m base
  git checkout -q -b pr
  echo b > docs/x.md
  git add . && git commit -q -m docs
  git checkout -q main
  echo c > unrelated.txt
  git add . && git commit -q -m "main moved on"
  git merge -q --no-ff pr -m "merge pr"
)

# git_web <sự kiện> <nhánh đích>: giá trị đầu ra web khi chạy trong repo tạm.
git_web() {
  (cd "$work/repo" && GITHUB_EVENT_NAME="$1" GITHUB_BASE_REF="$2" "$here/changes.sh" | grep '^web=')
}

expect() { # expect <tên ca> <mong đợi> <thực tế>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    printf '  expected: %s\n  actual:   %s\n' "$2" "$3"
    failed=1
  fi
}

expect "PR chỉ có tài liệu (diff so với cha thứ nhất, bỏ phần main đã đi tiếp)" "web=false" "$(git_web pull_request main)"
expect "push luôn chạy đủ" "web=true" "$(git_web push "")"
expect "PR vào nhánh release luôn chạy đủ" "web=true" "$(git_web pull_request release)"
(cd "$work/repo" && git checkout -q HEAD^1)
expect "không có commit merge thì chạy đủ" "web=true" "$(git_web pull_request main)"

exit "$failed"
