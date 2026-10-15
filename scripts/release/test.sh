#!/usr/bin/env bash
# Kiểm version.sh và notes.sh trên các repo git tạm với tag và lịch sử giả.
# Cách dùng: scripts/release/test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    printf '  expected: %s\n  actual:   %s\n' "$2" "$3"
    failed=1
  fi
}

newrepo() {
  rm -rf "$work/repo"
  git init -q -b main "$work/repo"
  cd "$work/repo"
  git config user.name test
  git config user.email test@example.com
  git config commit.gpgsign false
  git commit -q --allow-empty -m "init"
}

commit() { git commit -q --allow-empty -m "$1"; }

# Một PR như GitHub merge: các commit của nhánh, rồi commit merge có thân là tiêu đề PR.
merge_pr() { # merge_pr <number> <title> <branch commit subject>...
  local n="$1" title="$2" base
  shift 2
  base="$(git rev-parse --abbrev-ref HEAD)"
  git checkout -q -b "pr$n"
  for s in "$@"; do commit "$s"; done
  git checkout -q "$base"
  git merge -q --no-ff "pr$n" -m "Merge pull request #$n from someone/pr$n" -m "$title"
  git branch -q -D "pr$n"
}

# --- version.sh -------------------------------------------------------------------------------------------
# shellcheck disable=SC2119,SC2120 # the arguments are optional
version() { (cd "$work/repo" && "$here/version.sh" "$@"); }

newrepo
check "no tag, no VERSION" "0.0.1" "$(version)"
echo "0.3.0" > VERSION
check "no tag, VERSION set" "0.3.0" "$(version)"

git tag v0.2.9; git tag v0.2.10; git tag v0.1.0; git tag v1.0.0-rc1; git tag nightly
echo "0.2.10" > VERSION
check "VERSION equals newest tag: patch bump, numeric order (0.2.10 > 0.2.9)" "0.2.11" "$(version)"
echo "0.2.9" > VERSION
check "VERSION behind newest tag: patch bump of the tag" "0.2.11" "$(version)"
echo "0.3.0" > VERSION
check "VERSION ahead of newest tag" "0.3.0" "$(version)"
echo "v1.0.0" > VERSION
check "VERSION with leading v and trailing newline" "1.0.0" "$(version)"
rm VERSION
check "no VERSION file" "0.2.11" "$(version)"
echo "banana" > VERSION
if version >/dev/null 2>&1; then check "invalid VERSION is rejected" "error" "success"; else check "invalid VERSION is rejected" "error" "error"; fi

# --- notes.sh ---------------------------------------------------------------------------------------------
notes() { (cd "$work/repo" && "$here/notes.sh" "$@"); }

newrepo
git tag v0.2.0
merge_pr 10 "feat(desktop): add dark mode" "wip dark mode" "more wip"
merge_pr 11 "fix(worker): keep lease alive on reconnect" "fix lease"
merge_pr 12 "refactor(hub): split runs engine" "split"
merge_pr 13 "chore: bump deps" "deps"
commit "feat(web): squash-merged filter (#14)"
commit "docs: explain the release flow"
commit "Merge branch 'main' into feature"
git tag v0.2.1
expected="### Features

- **desktop:** add dark mode (#10)
- **web:** squash-merged filter (#14)

### Fixes

- **worker:** keep lease alive on reconnect (#11)

### Other

- **hub:** split runs engine (#12)
- **docs:** explain the release flow"
check "generated notes, grouped, PR titles instead of branch commits, chore and merges dropped" "$expected" "$(notes v0.2.1 v0.2.0)"

# PR đồng bộ main -> release: bản thân nó không được liệt kê, những PR nó mang theo thì có.
git checkout -q -b release v0.2.0
git merge -q --no-ff main -m "Merge pull request #20 from someone/sync" -m "Release 0.2.1"
git tag v0.2.1-sync
check "release sync merge lists the PRs it carries" "$expected" "$(notes v0.2.1-sync v0.2.0)"

# Tiêu đề chuyển nhánh vẫn là "plumbing" dù không mang merge PR nào: commit trực tiếp của nó phải còn hiện.
newrepo
git tag v0.2.0
git checkout -q -b side
commit "fix(hub): direct fix"
git checkout -q main
git merge -q --no-ff side -m "Merge pull request #30 from someone/side" -m "Release v0.2.1"
git tag v0.2.1
check "plumbing PR title does not hide direct commits" "### Fixes

- **hub:** direct fix" "$(notes v0.2.1 v0.2.0)"

newrepo
git tag v0.2.0
commit "chore: tidy"
git tag v0.2.1
check "nothing to list" "No user-facing changes." "$(notes v0.2.1 v0.2.0)"

# RELEASE_NOTES.md viết tay thắng ghi chú tự sinh; các mục phiên bản khác bị bỏ qua.
newrepo
git tag v0.2.0
commit "feat: something generated"
git tag v0.3.0
cat > RELEASE_NOTES.md <<'NOTES'
# Release notes

## v0.3.1

Not this one.

## v0.3.0 - 2026-10-15

Hand-written headline.

- Item one
- Item two

## v0.2.0

Old.
NOTES
check "RELEASE_NOTES.md section is used" "Hand-written headline.

- Item one
- Item two" "$(notes v0.3.0 v0.2.0)"
sed -i.bak '/^## v0.3.0/,/^## v0.2.0/{/^## v0.2.0/!d;}' RELEASE_NOTES.md && rm RELEASE_NOTES.md.bak
check "RELEASE_NOTES.md without the section falls back to generated" "### Features

- something generated" "$(notes v0.3.0 v0.2.0)"
check "typed input beats the file" "typed in the form" "$(RELEASE_NOTES='typed in the form' notes v0.3.0 v0.2.0)"

# Tag đầu tiên không có tag trước thì liệt kê cả lịch sử.
newrepo
commit "fix: first"
git tag v0.1.0
check "first release has no previous tag" "### Fixes

- first

### Other

- init" "$(notes v0.1.0)"

exit "$failed"
