#!/bin/zsh
# Tự đẩy việc agent đã xong (exit 0) có commit mới: tạo PR nếu chưa có, đẩy lên nhánh PR nếu đã có. Ghi autopush.log.
source ${0:A:h}/env.sh
LOG=$S/autopush.log; touch $S/autopush.done
while true; do
  python3 - "$A" > $S/autopush.todo <<'PY'
import json,sys,re
A=sys.argv[1]; j=json.load(open(A+'/jobs.json'))
done_ok=set()
for l in open(A+'/supervisor.log'):
    m=re.match(r'^[0-9:]+ (\S+) xong \(exit 0',l)
    if m: done_ok.add(m.group(1))
for k,v in j.items():
    if v.get('status')=='done' and k in done_ok: print(k, v['wt'])
PY
  while read job wt; do
    [ -d "$wt" ] || continue
    grep -qx "$job" $S/autopush.hold 2>/dev/null && continue  # việc cần người điều phối soát tay trước khi push
    head=$(git -C "$wt" rev-parse HEAD 2>/dev/null) || continue
    grep -qx "$job $head" $S/autopush.done && continue
    git -C "$wt" fetch -q origin 2>/dev/null
    n=$(git -C "$wt" log --oneline origin/main..HEAD --no-merges 2>/dev/null | wc -l | tr -d ' ')
    if [ "$n" = 0 ]; then echo "$job $head" >> $S/autopush.done; continue; fi
    b=$(git -C "$wt" branch --show-current)
    [ -z "$b" ] && { echo "$job $head" >> $S/autopush.done; continue; }
    git -C "$wt" config --worktree --unset remote.origin.pushurl 2>/dev/null
    if git -C "$wt" ls-remote --exit-code origin "refs/heads/$b" >/dev/null 2>&1; then
      git -C "$wt" merge -q --no-edit "origin/$b" 2>/dev/null || git -C "$wt" merge --abort 2>/dev/null
    fi
    t=$(git -C "$wt" log --format=%s origin/main..HEAD --no-merges | tail -1)
    out=$($SCRIPTS/push-nv.sh "$wt" "$t" "Task $job. Agent ran affected checks (see summary); GitHub CI runs the full suite." 2>&1 | tail -1)
    echo "$(date +%H:%M) $job → $out" >> $LOG
    echo "$job $head" >> $S/autopush.done
  done < $S/autopush.todo
  sleep 120
done
