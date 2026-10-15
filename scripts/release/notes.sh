#!/usr/bin/env bash
# In ghi chú phát hành tiếng Anh (thân markdown) của một bản phát hành.
#
# Cách dùng: scripts/release/notes.sh <tag> [tag-trước]   (chạy trong repo, có đủ tag và lịch sử)
#
# Nguồn, cái nào có trước dùng cái đó:
#   1. $RELEASE_NOTES: chữ nhập ở ô notes của nút "Run workflow";
#   2. mục `## v<x.y.z>` trong RELEASE_NOTES.md ở gốc repo (viết tay);
#   3. tự sinh từ các PR đã merge giữa <tag-trước> và <tag>, nhóm Features / Fixes / Other theo tiền tố conventional
#      commit của tiêu đề PR.
set -euo pipefail

tag="${1:?Cách dùng: scripts/release/notes.sh <tag> [tag-trước]}"
previous="${2:-}"
notes_file="${NOTES_FILE:-RELEASE_NOTES.md}"
version="${tag#v}"

if [ -n "${RELEASE_NOTES:-}" ]; then
  printf '%s\n' "$RELEASE_NOTES"
  exit 0
fi

if [ -f "$notes_file" ]; then
  section="$(awk -v ver="$version" '
    BEGIN { gsub(/\./, "\\.", ver); head = "^##[ \t]+v?" ver "([ \t].*)?$" }
    /^## / { if (on) exit; if ($0 ~ head) { on = 1; next } }
    on { print }
  ' "$notes_file")"
  # Cắt dòng trống đầu/cuối; mục rỗng thì rơi xuống ghi chú tự sinh.
  section="$(printf '%s\n' "$section" | sed -e '/./,$!d' | sed -e ':a' -e '/^[[:space:]]*$/{$d;N;ba' -e '}')"
  if [ -n "${section//[[:space:]]/}" ]; then
    printf '%s\n' "$section"
    exit 0
  fi
fi

range="$tag"
[ -n "$previous" ] && range="$previous..$tag"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
: > "$tmp/excluded"

pr_merge='^Merge pull request #([0-9]+) '
# Tiêu đề của PR chuyển nhánh ("Release v0.3.0", "Merge main into release"): bản thân nó không phải thay đổi nào.
plumbing='^(release|merge|sync)([^a-zA-Z]|$)'

# Đúng với merge mang theo các merge PR khác (main -> release): đó là đồng bộ nhánh, không phải thay đổi.
carries_pr_merge() { [ -n "$(git rev-list --merges --grep='^Merge pull request #' "$1..$2" | head -n1)" ]; }

# GitHub đặt tiêu đề PR ở dòng đầu thân commit merge. `read` dừng ở dấu xuống dòng đầu, nên biến `body` bên dưới đúng là
# dòng đó.
# Lượt 1: merge PR mang theo commit riêng của nhánh, không được liệt kê lại cạnh tiêu đề PR. Merge mang theo merge PR khác
# (main -> release) hoặc có tiêu đề chuyển nhánh thì bỏ qua mà không giấu những gì nó mang theo.
records="$tmp/records"
git log --reverse --format='%H%x1f%P%x1f%s%x1f%b%x1e' "$range" > "$records"
while IFS= read -r -d $'\x1e' record; do
  record="${record#$'\n'}"
  IFS=$'\x1f' read -r hash parents subject body <<< "$record"
  [[ "$subject" =~ $pr_merge ]] || continue
  lower="$(printf '%s' "$body" | tr '[:upper:]' '[:lower:]')"
  [[ "$lower" =~ $plumbing ]] && continue
  read -ra parent <<< "$parents"
  [ "${#parent[@]}" -ge 2 ] || continue
  carries_pr_merge "${parent[0]}" "${parent[1]}" && continue
  git rev-list "${parent[0]}..${parent[1]}" >> "$tmp/excluded"
done < "$records"

features="$tmp/features"; fixes="$tmp/fixes"; other="$tmp/other"
: > "$features"; : > "$fixes"; : > "$other"

typed='^([A-Za-z]+)(\(([^)]*)\))?!?:[[:space:]]*(.*)$'
trailing_pr='^(.*[^[:space:]])[[:space:]]+\(#([0-9]+)\)$'

add() { # add <title> [pr]
  local title="$1" pr="${2:-}" kind="" scope="" text out lower
  title="${title%"${title##*[![:space:]]}"}"
  if [[ "$title" =~ $trailing_pr ]]; then
    title="${BASH_REMATCH[1]}"
    pr="${pr:-${BASH_REMATCH[2]}}"
  fi
  lower="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"
  [[ "$lower" =~ $plumbing ]] && return
  text="$title"
  if [[ "$title" =~ $typed ]]; then
    kind="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    scope="${BASH_REMATCH[3]}"
    text="${BASH_REMATCH[4]}"
  fi
  [ "$kind" = chore ] && return
  # Không có scope thì mục ngoài Features / Fixes lấy loại làm nhãn (docs, refactor, ...).
  if [ -z "$scope" ] && [ -n "$kind" ] && [ "$kind" != feat ] && [ "$kind" != fix ]; then scope="$kind"; fi
  out="- "
  [ -n "$scope" ] && out="$out**$scope:** "
  out="$out$text"
  [ -n "$pr" ] && out="$out (#$pr)"
  case "$kind" in
    feat) echo "$out" >> "$features" ;;
    fix) echo "$out" >> "$fixes" ;;
    *) echo "$out" >> "$other" ;;
  esac
}

# Lượt 2: mỗi merge PR một mục, thêm các commit trực tiếp (squash merge, push không qua PR).
while IFS= read -r -d $'\x1e' record; do
  record="${record#$'\n'}"
  IFS=$'\x1f' read -r hash parents subject body <<< "$record"
  read -ra parent <<< "$parents"
  if [ "${#parent[@]}" -ge 2 ]; then
    [[ "$subject" =~ $pr_merge ]] || continue
    pr="${BASH_REMATCH[1]}"
    carries_pr_merge "${parent[0]}" "${parent[1]}" && continue
    add "$body" "$pr"
  else
    grep -qxF "$hash" "$tmp/excluded" && continue
    add "$subject"
  fi
done < "$records"

emitted=0
section() { # section <heading> <file>
  [ -s "$2" ] || return 0
  [ "$emitted" = 1 ] && echo
  printf '### %s\n\n' "$1"
  cat "$2"
  emitted=1
}
section Features "$features"
section Fixes "$fixes"
section Other "$other"

if [ "$emitted" = 0 ]; then
  echo "No user-facing changes."
fi
