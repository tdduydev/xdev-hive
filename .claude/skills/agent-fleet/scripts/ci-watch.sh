#!/bin/zsh
# Theo dõi PR mở: lỗi do test flaky đã biết thì tự chạy lại; lỗi khác thì in ra và thoát để người điều phối xử lý.
source ${0:A:h}/env.sh
fleet_gh_repo || exit 1
KNOWN='ws.db.test.ts|mode-editor.test.tsx|routing.db.test.ts|mcp-artifacts.db.test.ts|compile.test.ts|panel.test.tsx|public-link-dialog.test.tsx|library.test.tsx|TestChatDetachAttachKill|TestStdinClosedDetaches|TestLocalSlowClientDropped|TestLocalPostToolIsFast|TestOpenInputResizeClose|plans-screen.test.tsx|skills-screen.test.tsx'
touch $S/seen-fail.txt $S/rerun.txt
while true; do
  for row in $(gh pr list --repo $FLEET_GH_REPO --state open --json number,headRefOid,statusCheckRollup --jq '.[]|select([.statusCheckRollup[]?.conclusion]|index("FAILURE"))|"\(.number):\(.headRefOid[0:7])"'); do
    grep -qxF $row $S/seen-fail.txt && continue
    p=${row%%:*}
    links=$(gh pr checks $p --repo $FLEET_GH_REPO --json state,link -q '.[]|select(.state=="FAILURE")|.link')
    known=1
    for l in ${(f)links}; do job=${l##*/}; run=$(echo $l | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
      log=$(gh api --allow-escape-sequences repos/$FLEET_GH_REPO/actions/jobs/$job/logs 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -E -- '--- FAIL|FAIL  ' )
      if echo "$log" | grep -qE "$KNOWN" && ! echo "$log" | grep -vE "$KNOWN" | grep -qE -- '--- FAIL: Test|FAIL  src'; then
        grep -qxF "$row:$run" $S/rerun.txt && { known=0; continue; }
        until [ "$(gh run view $run --repo $FLEET_GH_REPO --json status -q .status)" = completed ]; do sleep 30; done
        gh run rerun $run --failed --repo $FLEET_GH_REPO >/dev/null 2>&1 && echo "$row:$run" >> $S/rerun.txt && echo "$(date +%H:%M) rerun $row ($run)" >> $S/ci-watch.log
      else known=0; fi
    done
    if [ $known = 0 ]; then echo $row >> $S/seen-fail.txt; echo "FAILED: $row"; exit 0; fi
  done
  sleep 90
done
