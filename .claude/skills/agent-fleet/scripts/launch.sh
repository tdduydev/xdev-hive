#!/bin/zsh
# $1 = tên việc, $2 = worktree, $3 = chế độ (code|read); biến môi trường ACCOUNT=claude-N là tài khoản chạy
source ${0:A:h}/env.sh
cd "$2" || exit 1
export CLAUDE_CONFIG_DIR=$HOME/.xdev-hive/accounts/${ACCOUNT:?đặt ACCOUNT=claude-N}
export PATH="$HOME/.cargo/bin:$PATH"
prompt="$(cat $SCRIPTS/common.md; echo; cat $A/$1.md)"
prompt=${prompt//\{\{SCRIPTS\}\}/$SCRIPTS}
if [ "$3" = read ]; then
  tools=(Read Glob Grep Write)
else
  tools=(Bash Read Edit Write Glob Grep)
fi
claude -p "$prompt" --permission-mode acceptEdits --allowedTools $tools \
  --disallowedTools "Bash(git push:*)" "Bash(gh:*)" "Bash(rm -rf:*)" "Bash(sudo:*)" \
  --add-dir "$A" --add-dir "$SCRIPTS" \
  --output-format stream-json --verbose > "$A/log-$1.jsonl" 2> "$A/err-$1.log"
echo "exit $?" > "$A/done-$1"
