#!/bin/zsh
# usage: after-done-job.sh "<JOB1 JOB2 …>" <JOB> <model> <tier> — nhánh nối tiếp: đợi agent của các việc phụ thuộc XONG (không đợi merge), mở worktree ai/<JOB> từ main + gộp nhánh các việc đó
source ${0:A:h}/env.sh
for d in ${=1}; do until python3 -c "import json,sys;j=json.load(open('$A/jobs.json'));sys.exit(0 if j.get('$d',{}).get('status')=='done' else 1)" 2>/dev/null && [ "$(grep -E "^[0-9:]+ $d xong" $A/supervisor.log | tail -1 | grep -c 'exit 0')" = 1 ]; do sleep 60; done; done
cd $FLEET_REPO && git fetch -q
wt=$FLEET_WT/$2
git worktree prune; git worktree add -q -B ai/$2 $wt origin/main && git -C $wt config --worktree remote.origin.pushurl no-push://agent
for d in ${=1}; do git -C $wt merge -q --no-edit ai/$d || { git -C $wt merge --abort; echo "$(date +%H:%M) $2: xung đột khi gộp ai/$d — agent tự gộp" >> $A/supervisor.log; echo "LƯU Ý: chưa gộp được nhánh ai/$d (xung đột). Việc đầu tiên: \`git merge ai/$d\` và giải xung đột." >> $A/$2.md; }; done
python3 $SCRIPTS/add-job.py $2 $wt $3 $4
echo "$(date +%H:%M) queued $2 (stacked on $1)" >> $A/supervisor.log
