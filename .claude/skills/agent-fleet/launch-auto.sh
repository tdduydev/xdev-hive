#!/bin/zsh
# $1 = việc (đề bài ở $AGENT_DIR/<việc>.md), $2 = worktree, $3 = tài khoản theo thứ tự thử (claude-N hoặc agy, cách nhau dấu phẩy),
# $4 = 1 nếu là việc tăng tốc. Biến: MODEL, EFFORT, RESUME (worktree đã có phần dở), AGENT_ADD_DIRS (thư mục chỉ đọc thêm).
# Thư mục làm việc của đội agent (đề bài, log, jobs.json); quy tắc chung lấy từ thư mục skill.
A=${AGENT_DIR:-$HOME/.cache/xdev-hive-agents}
SKILL=${0:A:h}
cd "$2" || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
# Một thư mục build Rust chung: cargo khoá nó nên các worktree build lần lượt, không biên dịch Tauri song song từ đầu.
export CARGO_TARGET_DIR=$HOME/.cache/xdev-hive-agents-target
base="$(cat $SKILL/common.md; echo; [ "$4" = 1 ] && cat $SKILL/perf-common.md; echo; cat $A/$1.md)"
extra=()
for d in ${=AGENT_ADD_DIRS}; do extra+=(--add-dir "$d"); done
round=0
for acct in ${(s:,:)3}; do
  round=$((round+1))
  prompt="$base"
  if [ $round -gt 1 ] || [ -n "$RESUME" ]; then
    prompt="$base

# TIẾP TỤC: lượt trước (tài khoản khác) đã dừng giữa chừng vì hết lượt dùng. Xem \`git log origin/main..HEAD\`, \`git status\`, \`git diff\` và file tóm tắt nếu đã có, rồi làm tiếp phần còn lại; không làm lại phần đã commit."
  fi
  log=$A/log-$1-$round.jsonl
  if [ "$acct" = agy ]; then
    nice -n 10 agy -p "$prompt" --model "${MODEL:-claude-opus-5-5}-${EFFORT:-high}" --output-format stream-json --sandbox --dangerously-skip-permissions \
      --add-dir "$A" $extra < /dev/null > $log 2> $A/err-$1-$round.log
  else
    CLAUDE_CONFIG_DIR=$HOME/.xdev-hive/accounts/$acct nice -n 10 claude -p "$prompt" --model "${MODEL:-claude-opus-5-5}" --effort "${EFFORT:-high}" --permission-mode acceptEdits \
      --allowedTools Bash Read Edit Write Glob Grep \
      --disallowedTools "Bash(git push:*)" "Bash(gh:*)" "Bash(rm -rf:*)" "Bash(sudo:*)" \
      --add-dir "$A" $extra --output-format stream-json --verbose < /dev/null > $log 2> $A/err-$1-$round.log
  fi
  code=$?
  ln -sf $log $A/log-$1.jsonl
  # Kết quả cuối báo hết lượt dùng (không phải đoạn code agent đọc): sang tài khoản kế.
  if tail -3 $log | grep -qiE '"is_error":true.*(limit|quota)|usage limit reached|hit your (usage )?limit|out of (credits|quota)|RESOURCE_EXHAUSTED|quota reached|Individual quota'; then
    echo "$acct hết lượt (vòng $round)" >> $A/switch-$1.log
    continue
  fi
  echo "exit $code ($acct)" > $A/done-$1
  exit 0
done
echo "hết tài khoản" > $A/done-$1
