#!/bin/zsh
# Hàng merge tại máy (repo tài khoản cá nhân không có GitHub merge queue): mỗi lần một PR — cập nhật với main mới nhất,
# chờ CI chạy trên đúng bản đó, xanh thì merge. Lỗi do test chập chờn đã biết thì chạy lại một lần; lỗi khác thì in ra và thoát.
source ${0:A:h}/env.sh
fleet_gh_repo || exit 1
R=$FLEET_GH_REPO; LOG=$S/merge-queue.log
KNOWN=$(grep -oE "KNOWN='[^']+'" $SCRIPTS/ci-watch.sh | cut -d"'" -f2)
touch $S/mq-skip.txt $S/mq-first.txt
log(){ echo "$(date +%H:%M) $*" | tee -a $LOG; }
checks_done(){ [ "$(gh pr checks $1 --repo $R --json state -q '[.[]|select(.state=="PENDING" or .state=="QUEUED" or .state=="IN_PROGRESS")]|length' 2>/dev/null)" = 0 ]; }
while true; do
  prs=$(gh pr list --repo $R --state open --json number,isDraft -q '[.[]|select(.isDraft|not)|.number]|sort|.[]')
  [ -z "$prs" ] && { sleep 120; continue; }
  first=$(grep -xFf <(echo $prs | tr ' ' '\n') $S/mq-first.txt 2>/dev/null); prs="$first
$(echo $prs | grep -vxF -f $S/mq-first.txt 2>/dev/null || echo $prs)"
  progressed=0
  for p in ${(f)prs}; do
    grep -qx $p $S/mq-skip.txt && continue
    st=$(gh pr view $p --repo $R --json mergeStateStatus -q .mergeStateStatus)
    [ "$st" = DIRTY ] && { log "#$p xung đột với main — bỏ qua tới khi sửa"; echo $p >> $S/mq-skip.txt; continue; }
    head=$(gh pr view $p --repo $R --json headRefOid -q .headRefOid)
    behind=$(gh api repos/$R/compare/main...$head -q .behind_by 2>/dev/null)
    if [ "${behind:-1}" != 0 ]; then gh pr update-branch $p --repo $R >/dev/null 2>&1 || { log "#$p không cập nhật được"; echo $p >> $S/mq-skip.txt; continue; }; log "#$p cập nhật với main, chờ CI"; sleep 30; fi
    until checks_done $p; do sleep 60; done
    fails=$(gh pr checks $p --repo $R --json state,link -q '.[]|select(.state=="FAILURE")|.link')
    if [ -n "$fails" ]; then
      known=1
      for l in ${(f)fails}; do lg=$(gh api --allow-escape-sequences repos/$R/actions/jobs/${l##*/}/logs 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -E -- '--- FAIL|FAIL  |FAIL   |error TS|× ')
        echo "$lg" | grep -qE "$KNOWN" && ! echo "$lg" | grep -vE "$KNOWN" | grep -qE -- '--- FAIL: Test|FAIL +(db|unit)? *src|error TS|× ' || known=0; done
      h=$(gh pr view $p --repo $R --json headRefOid -q .headRefOid | cut -c1-7)
      if [ $known = 1 ] && ! grep -qx "$p:$h" $S/mq-rerun.txt 2>/dev/null; then
        for r in $(echo $fails | grep -oE 'runs/[0-9]+' | cut -d/ -f2 | sort -u); do gh run rerun $r --failed --repo $R >/dev/null 2>&1; done
        echo "$p:$h" >> $S/mq-rerun.txt; log "#$p lỗi chập chờn đã biết — chạy lại"; sleep 60; until checks_done $p; do sleep 60; done
        fails=$(gh pr checks $p --repo $R --json state -q '[.[]|select(.state=="FAILURE")]|length'); [ "$fails" = 0 ] && fails=""
      fi
      [ -n "$fails" ] && { log "#$p CI đỏ"; echo $p >> $S/mq-skip.txt; echo "FAILED: $p"; exit 0; }
    fi
    gh pr merge $p --repo $R --merge --delete-branch >/dev/null 2>&1 && { log "#$p merged"; progressed=1; break; } || log "#$p merge lỗi"
  done
  [ $progressed = 0 ] && sleep 120
done
