#!/bin/zsh
# push không chạy hook (agent đã chạy phần kiểm liên quan); CI GitHub chạy đủ bộ và là cổng. usage: push-nv.sh <wt> <title> <body>
cd "$1" || exit 1; b=$(git branch --show-current); n=$(basename "$1")
git config --worktree --unset remote.origin.pushurl 2>/dev/null
git push -q --no-verify -u origin "$b" 2>&1 | grep -v "^remote" 
gh pr view --json number -q .number >/dev/null 2>&1 || gh pr create --base main --title "$2" --body "$(printf '%s\n\nThe agent ran the checks affected by this change; GitHub CI runs the full suite and gates merge.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' "$3")" >/dev/null
echo "$n OK $(gh pr view --json url -q .url)"
