#!/bin/zsh
# $1 = việc, $2 = worktree, $3 = danh sách tài khoản cách nhau dấu phẩy (claude-N, codex-N hoặc agy), $4 = có perf (1/0)
# Biến môi trường: MODEL/EFFORT cho tài khoản Claude, CODEX_EFFORT (high|medium) cho tài khoản Codex.
source ${0:A:h}/env.sh
cd "$2" || { echo "$(date +%H:%M) $1: KHÔNG CÓ WORKTREE $2 — không chạy được" >> $A/supervisor.log; exit 1; }
export PATH="$HOME/.cargo/bin:$PATH"
# Một thư mục build Rust chung: cargo khoá nó nên các worktree build lần lượt, không biên dịch Tauri song song từ đầu.
export CARGO_TARGET_DIR=$HOME/.cache/xdev-hive-agents-target
# Tiết kiệm token (đo 2026-10-13: output Bash ~22% chi phí, subagent Opus, ngữ cảnh >150k ở 43% lượt của agent).
export BASH_MAX_OUTPUT_LENGTH=15000 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70 CLAUDE_CODE_SUBAGENT_MODEL=sonnet MAX_MCP_OUTPUT_TOKENS=15000
base="$(cat $SCRIPTS/common.md; echo; [ "$4" = 1 ] && cat $SCRIPTS/perf-common.md; echo; cat $A/$1.md)"
base=${base//\{\{SCRIPTS\}\}/$SCRIPTS}
# Codex không có danh sách lệnh cấm như Claude: đặt bản chặn git push/gh/sudo/rm -rf đầu PATH (xem $SCRIPTS/shims/).
REAL_GIT="$(command -v git)"
codex_home() { [ "$1" = codex-1 ] && echo "$HOME/.codex" || echo "$HOME/.xdev-hive/accounts/$1"; }
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
      --add-dir "$A" --add-dir "$SCRIPTS" < /dev/null > $log 2> $A/err-$1-$round.log
  elif [[ $acct == codex-* ]]; then
    # --ignore-user-config: config.toml của tài khoản bật MCP xdev-hive/node_repl, agent nền không cần; đăng nhập vẫn lấy từ CODEX_HOME.
    # allow_login_shell=false: shell đăng nhập của macOS (path_helper) đảo PATH và làm mất bản chặn trong shims/.
    printf '%s\n\n%s' "$prompt" "$(cat $SCRIPTS/common-codex.md)" | CODEX_HOME=$(codex_home $acct) REAL_GIT="$REAL_GIT" PATH="$SCRIPTS/shims:$PATH" nice -n 10 \
      codex exec --json --ignore-user-config --dangerously-bypass-approvals-and-sandbox -C "$2" \
      -c model_reasoning_effort="${CODEX_EFFORT:-medium}" -c allow_login_shell=false ${CODEX_MODEL:+-m "$CODEX_MODEL"} - > $log 2> $A/err-$1-$round.log
  else
    CLAUDE_CONFIG_DIR=$HOME/.xdev-hive/accounts/$acct nice -n 10 claude -p "$prompt" --model "${MODEL:-claude-opus-5-5}" --effort "${EFFORT:-high}" --permission-mode acceptEdits \
      --allowedTools Bash Read Edit Write Glob Grep \
      --disallowedTools "Bash(git push:*)" "Bash(gh:*)" "Bash(rm -rf:*)" "Bash(sudo:*)" \
      --add-dir "$A" --add-dir "$SCRIPTS" --output-format stream-json --verbose < /dev/null > $log 2> $A/err-$1-$round.log
  fi
  code=$?
  ln -sf $log $A/log-$1.jsonl
  # Kết quả cuối báo hết lượt dùng (không phải đoạn code agent đọc): sang tài khoản kế.
  if [[ $acct == codex-* ]]; then
    # Codex báo hết lượt bằng sự kiện error/turn.failed ở cuối log (hoặc dòng stderr), không phải đoạn code agent đọc.
    if { tail -5 $log | grep -E '"type":"(error|turn\.failed)"'; [ $code -ne 0 ] && tail -5 $A/err-$1-$round.log; } | grep -qiE 'usage limit|rate limit|quota|try again at'; then
      python3 -I $SCRIPTS/codex_cool.py $acct $log $A/err-$1-$round.log
      echo "$acct hết lượt (vòng $round)" >> $A/switch-$1.log
      continue
    fi
  elif tail -3 $log | grep -qiE '"is_error":true.*(limit|quota)|usage limit reached|hit your (usage )?limit|out of (credits|quota)|RESOURCE_EXHAUSTED|quota reached|Individual quota'; then
    echo "$acct hết lượt (vòng $round)" >> $A/switch-$1.log
    continue
  fi
  echo "exit $code ($acct)" > $A/done-$1
  exit 0
done
echo "hết tài khoản" > $A/done-$1
