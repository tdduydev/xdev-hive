#!/bin/zsh
# usage: after-merge-job.sh <wait-branch> <JOB> <model> <tier>  — đợi nhánh merge, mở worktree mới ai/<JOB> từ main, xếp việc <JOB>
source ${0:A:h}/env.sh
fleet_gh_repo || exit 1
until [ "$(gh pr list --repo $FLEET_GH_REPO --head $1 --state merged --json number -q 'length')" = "1" ]; do sleep 60; done
cd $FLEET_REPO && git fetch -q
wt=$FLEET_WT/$2
git worktree add -q -b ai/$2 $wt origin/main && git -C $wt config --worktree remote.origin.pushurl no-push://agent
python3 $SCRIPTS/add-job.py $2 $wt $3 $4
echo "$(date +%H:%M) queued $2 after $1 merged" >> $A/supervisor.log
