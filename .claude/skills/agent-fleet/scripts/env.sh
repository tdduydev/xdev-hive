# Biến dùng chung của bộ điều phối; các script zsh `source` file này. Mọi biến đều ghi đè được từ môi trường.
#   FLEET_DIR      thư mục chạy (mặc định ~/.xdev-hive/fleet): mq-*.txt, autopush.*, log; các việc nằm ở $FLEET_DIR/agents
#   FLEET_REPO     checkout chính của repo chứa script (chạy từ worktree thì lấy checkout chính)
#   FLEET_WT       nơi đặt worktree của từng việc (mặc định <repo>/../xdev-hive-wt)
#   FLEET_GH_REPO  owner/repo trên GitHub (mặc định hỏi `gh repo view`; xem fleet_gh_repo)
SCRIPTS=${${(%):-%x}:A:h}
export FLEET_DIR=${FLEET_DIR:-$HOME/.xdev-hive/fleet}
if [ -z "$FLEET_REPO" ]; then
  # --git-common-dir cho ra .git của checkout chính ngay cả khi script nằm trong một worktree.
  common=$(git -C "$SCRIPTS" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  FLEET_REPO=${common%/.git}
fi
export FLEET_REPO
export FLEET_WT=${FLEET_WT:-${FLEET_REPO:h}/xdev-hive-wt}
S=$FLEET_DIR
A=$FLEET_DIR/agents
mkdir -p "$A"
[ -f "$A/jobs.json" ] || echo '{}' > "$A/jobs.json"

fleet_gh_repo() {
  [ -n "$FLEET_GH_REPO" ] || FLEET_GH_REPO=$(cd "$FLEET_REPO" && gh repo view --json nameWithOwner -q .nameWithOwner)
  [ -n "$FLEET_GH_REPO" ] || { echo "không đọc được repo GitHub: đặt FLEET_GH_REPO=<owner>/<repo>" >&2; return 1; }
  export FLEET_GH_REPO
}
