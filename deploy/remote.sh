#!/bin/sh
# Triển khai hub lên một máy chủ qua SSH: deploy/remote.sh <user@máy-chủ> [git-ref, mặc định main]
#
# Lần đầu cần HIVE_PUBLIC_URL (địa chỉ người dùng mở hub). Mật khẩu và secret được sinh ngay trên máy chủ, quyền 600,
# không in ra và không chép về máy dev. Lần sau giữ nguyên deploy/.env, chỉ thêm biến mới còn thiếu.
#
# Biến tuỳ chọn: HIVE_PUBLIC_URL, HIVE_BIND (0.0.0.0 cho máy chủ LAN không có HTTPS), HIVE_REMOTE_DIR (mặc định
# /opt/xdev-hive), HIVE_REPO_URL, HIVE_POSTGRES_IMAGE, HIVE_NODE_IMAGE (khi Docker Hub giới hạn lượt tải),
# HIVE_REMOTE_DOCKER (vd. "sudo docker" khi user không thuộc nhóm docker).
set -eu

target=${1:?Cách dùng: deploy/remote.sh <user@máy-chủ> [git-ref]}
ref=${2:-main}

# Phần chạy trên máy chủ đọc từ stdin; tham số truyền qua `sh -s --` để không phải ghép chuỗi lệnh.
ssh "$target" sh -s -- \
  "${HIVE_REMOTE_DIR:-/opt/xdev-hive}" \
  "$ref" \
  "${HIVE_REPO_URL:-https://github.com/tdduydev/xdev-hive.git}" \
  "${HIVE_PUBLIC_URL:-}" \
  "${HIVE_BIND:-}" \
  "${HIVE_POSTGRES_IMAGE:-}" \
  "${HIVE_NODE_IMAGE:-}" \
  "${HIVE_REMOTE_DOCKER:-docker}" <<'REMOTE'
set -eu
dir=$1 ref=$2 repo=$3 public=$4 bind=$5 pg_image=$6 node_image=$7 docker=$8

fail() { echo "$*" >&2; exit 2; }
command -v git >/dev/null 2>&1 || fail "Máy chủ chưa có git."
command -v openssl >/dev/null 2>&1 || fail "Máy chủ chưa có openssl (cần để sinh secret)."
$docker version >/dev/null 2>&1 || fail "Không gọi được '$docker' (chưa cài, hoặc user không thuộc nhóm docker: đặt HIVE_REMOTE_DOCKER=\"sudo docker\")."
$docker compose version >/dev/null 2>&1 || fail "Máy chủ chưa có docker compose v2."

if [ ! -d "$dir/.git" ]; then
  if ! mkdir -p "$dir" 2>/dev/null; then
    sudo mkdir -p "$dir" && sudo chown "$(id -u):$(id -g)" "$dir"
  fi
  git clone --quiet "$repo" "$dir"
fi
cd "$dir"
git fetch --quiet --tags origin
# Nhánh thì lấy bản trên origin; tag hay commit thì dùng thẳng.
if git rev-parse --verify --quiet "origin/$ref" >/dev/null; then
  git checkout --quiet --detach "origin/$ref"
else
  git checkout --quiet --detach "$ref"
fi

env=deploy/.env
umask 077
if [ ! -f "$env" ]; then
  [ -n "$public" ] || fail "Lần triển khai đầu cần HIVE_PUBLIC_URL (vd. HIVE_PUBLIC_URL=http://<máy-chủ>:3000)."
  : >"$env"
  echo "Tạo ${dir}/${env} với secret mới."
fi
chmod 600 "$env"

has() { grep -q "^$1=" "$env"; }
# Thêm khi chưa có: không bao giờ đổi secret đã dùng (database đã khởi tạo với mật khẩu cũ).
add() { has "$1" || printf '%s=%s\n' "$1" "$2" >>"$env"; }
# Đặt theo tham số của lệnh (không phải secret), ghi đè giá trị cũ.
put() {
  if has "$1"; then
    tmp=$(mktemp "$env.XXXXXX")
    grep -v "^$1=" "$env" >"$tmp" || true
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
    mv "$tmp" "$env"
  else
    printf '%s=%s\n' "$1" "$2" >>"$env"
  fi
}

# Mật khẩu nằm trong URL postgres nên dùng hex, không dùng base64 (có + / =).
for key in HIVE_DB_ADMIN_PASSWORD HIVE_DB_OWNER_PASSWORD HIVE_DB_APP_PASSWORD HIVE_DB_AUTH_PASSWORD HIVE_DB_JOBS_PASSWORD; do
  add "$key" "$(openssl rand -hex 24)"
done
add HIVE_AUTH_SECRET "$(openssl rand -base64 32)"
add HIVE_MASTER_KEY "$(openssl rand -base64 32)"
add HIVE_PORT 3000
[ -n "$public" ] && put HIVE_PUBLIC_URL "$public"
[ -n "$bind" ] && put HIVE_BIND "$bind"
[ -n "$pg_image" ] && put HIVE_POSTGRES_IMAGE "$pg_image"
[ -n "$node_image" ] && put HIVE_NODE_IMAGE "$node_image"

commit=$(git rev-parse --short HEAD)
compose() { HIVE_VERSION="${commit}" $docker compose --env-file "$env" -f deploy/compose.yaml "$@"; }
echo "Dựng và chạy hub ở commit ${commit}…"
compose up -d --build

# Healthcheck của container gọi /api/v1/health; không cần curl trên máy chủ.
i=0
while :; do
  id=$(compose ps -q hub)
  status=$($docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo "?")
  [ "$status" = healthy ] && break
  i=$((i + 1))
  if [ "$i" -ge 36 ]; then
    echo "Hub chưa sẵn sàng sau 3 phút (trạng thái: ${status}). 80 dòng log cuối:" >&2
    compose logs --tail 80 hub >&2
    exit 1
  fi
  sleep 5
done
compose exec -T hub node -e "fetch('http://127.0.0.1:3000/api/v1/health').then((r) => r.text()).then(console.log)"
echo "Hub đang chạy ở commit ${commit}. Địa chỉ: $(grep '^HIVE_PUBLIC_URL=' "$env" | cut -d= -f2-)"
REMOTE
