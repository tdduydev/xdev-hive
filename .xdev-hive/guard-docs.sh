#!/bin/sh
# xdev-hive: block direct edits of docs rendered from xDev Hive (Claude Code PreToolUse hook).
root=$CLAUDE_PROJECT_DIR
[ -n "$root" ] || root=$(pwd)
file=$(sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
block() {
  echo "xDev Hive: $file is generated from Hive. Use doc_get + doc_propose (skill_get + skill_propose for a skill) instead of editing it." >&2
  exit 2
}
case "$file" in
  "$root/AGENTS.md"|"$root/CLAUDE.md"|"$root/docs/decisions.md"|AGENTS.md|CLAUDE.md|docs/decisions.md) block ;;
  "$root/.claude/rules/xdev-hive/"*|.claude/rules/xdev-hive/*) block ;;
  # Hive's AGENTS.md beside one the repo wrote itself (roadmap 38f).
  "$root/.xdev-hive/context/"*|.xdev-hive/context/*) block ;;
  # A nested AGENTS.md or a skill is Hive's when it has the managed block (docs for some paths, skills).
  */AGENTS.md|*/.claude/skills/*/SKILL.md|.claude/skills/*/SKILL.md) grep -q 'xdev-hive:start' "$file" 2>/dev/null && block ;;
esac
exit 0
