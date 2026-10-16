#!/bin/zsh
# Xoá worktree và nhánh local của PR đã merge (worktree sạch); không đụng worktree đang có agent chạy.
source ${0:A:h}/env.sh
fleet_gh_repo || exit 1
cd $FLEET_REPO || exit 1
git fetch -q --prune
merged=$(gh pr list --repo $FLEET_GH_REPO --state merged --limit 300 --json headRefName --jq '.[].headRefName')
running=$(python3 -c "import json;j=json.load(open('$A/jobs.json'));print('\n'.join(v['wt'] for v in j.values() if v['status'] in ('running','queued')))")
git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{sub("refs/heads/","",$2); print w" "$2}' | while read w b; do
  [ "$w" = "$PWD" ] && continue
  echo "$running" | grep -qx "$w" && continue
  echo "$merged" | grep -qx "$b" || continue
  git merge-base --is-ancestor "$b" origin/main || continue
  [ -z "$(git -C "$w" status --porcelain --untracked-files=no)" ] || continue
  git worktree remove --force "$w" && git branch -D "$b" >/dev/null && echo "removed $b"
done
for b in $(git branch --format='%(refname:short)'); do
  [ "$b" = main ] && continue
  git worktree list --porcelain | grep -q "refs/heads/$b$" && continue
  echo "$merged" | grep -qx "$b" && git merge-base --is-ancestor "$b" origin/main && git branch -D "$b" >/dev/null && echo "deleted $b"
done
git worktree prune
