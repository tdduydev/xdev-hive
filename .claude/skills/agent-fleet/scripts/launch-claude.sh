#!/bin/zsh
# $1 = việc, $2 = worktree, $3 = tài khoản (claude-N), $4 = model
source ${0:A:h}/env.sh
cd "$2" || exit 1
export CLAUDE_CONFIG_DIR=$HOME/.xdev-hive/accounts/$3
export PATH="$HOME/.cargo/bin:$PATH"
prompt="$(cat $SCRIPTS/common.md; echo; cat $A/$1.md)"
prompt=${prompt//\{\{SCRIPTS\}\}/$SCRIPTS}
claude -p "$prompt" --model "$4" --permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep \
  --disallowedTools "Bash(git push:*)" "Bash(gh:*)" "Bash(rm -rf:*)" "Bash(sudo:*)" \
  --add-dir "$A" --add-dir "$SCRIPTS" \
  --output-format stream-json --verbose < /dev/null > "$A/log-$1.jsonl" 2> "$A/err-$1.log"
echo "exit $?" > "$A/done-$1"
