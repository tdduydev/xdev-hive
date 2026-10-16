#!/bin/sh
# Triển khai hub lên một máy chủ qua SSH: deploy/remote.sh <user@máy-chủ> [git-ref, mặc định HEAD]
#
# Mã nguồn gửi từ máy dev bằng `git archive` (repo private: máy chủ không cần quyền GitHub), đúng commit của ref.
# git archive không chứa submodule: hub dùng packages/skill-pack/skills đã vendored, không cần tải xdev-skills.
# Lần đầu cần HIVE_PUBLIC_URL. Mật khẩu và secret được sinh ngay trên máy chủ, quyền 600, không in ra và không chép về
# máy dev. Lần sau giữ nguyên .env, chỉ thêm biến mới còn thiếu.
#
# Biến tuỳ chọn:
#   HIVE_REMOTE_DIR       thư mục trên máy chủ (mặc định /opt/xdev-hive); .env nằm ở <dir>/.env, mã ở <dir>/src
#   HIVE_COMPOSE_PROJECT  tên compose project (mặc định xdev-hive). Máy chủ đang chạy hệ khác cùng tên thì PHẢI đặt tên
#                         khác, nếu không compose sẽ coi container của hệ đó là của mình.
#   HIVE_PUBLIC_URL, HIVE_BIND (0.0.0.0 cho máy chủ LAN không có HTTPS), HIVE_POSTGRES_IMAGE, HIVE_NODE_IMAGE,
#   HIVE_REMOTE_DOCKER (vd. "sudo docker" khi user không thuộc nhóm docker)
#   HIVE_ORG_CREATORS     email người quản trị hub, cách nhau bằng dấu phẩy. Hub chỉ nhận người được mời, nên lần đầu
#                         phải có ít nhất một email ở đây để có người vào tạo tổ chức và gửi lời mời.
#   HIVE_TLS              cách Caddy lấy chứng chỉ khi HIVE_PUBLIC_URL là https://<tên miền> (lưu vào .env):
#                         dns-cloudflare (mặc định) lấy Let's Encrypt qua DNS-01 cho tên miền trỏ về IP nội bộ, cần
#                         CF_API_TOKEN trong <dir>/.env trên máy chủ (tự đặt, xem docs/self-hosting.md);
#                         auto để Caddy tự lấy qua HTTP khi máy chủ public ra Internet. https://<IP> luôn dùng CA nội bộ.
set -eu

target=${1:?Cách dùng: deploy/remote.sh <user@máy-chủ> [git-ref]}
ref=${2:-HEAD}
sha=$(git rev-parse --verify "$ref^{commit}")
short=$(git rev-parse --short "$sha")
dir=${HIVE_REMOTE_DIR:-/opt/xdev-hive}

# ssh nối mọi tham số thành một chuỗi lệnh cho shell của máy chủ: tham số rỗng sẽ mất và dấu cách tách nhầm, nên
# bọc từng tham số trong nháy đơn.
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

echo "Gửi mã nguồn commit $short tới $target:$dir/src.new…"
# shellcheck disable=SC2029 # dir được quote ở trên, cố ý bung ở máy dev.
git archive --format=tar "$sha" | gzip -c |
  ssh "$target" "set -e; d=$(q "$dir"); mkdir -p \"\$d\"; rm -rf \"\$d/src.new\"; mkdir \"\$d/src.new\"; tar -xzf - -C \"\$d/src.new\""

args="$(q "$dir") $(q "$short") $(q "${HIVE_COMPOSE_PROJECT:-}") $(q "${HIVE_PUBLIC_URL:-}") $(q "${HIVE_BIND:-}")"
args="$args $(q "${HIVE_POSTGRES_IMAGE:-}") $(q "${HIVE_NODE_IMAGE:-}") $(q "${HIVE_REMOTE_DOCKER:-docker}")"
args="$args $(q "${HIVE_ORG_CREATORS:-}") $(q "${HIVE_TLS:-}")"

# Phần chạy trên máy chủ đọc từ stdin.
# shellcheck disable=SC2029 # args được quote ở trên, cố ý bung ở máy dev.
ssh "$target" "sh -s -- $args" <<'REMOTE'
set -eu
dir=$1 commit=$2 project=$3 public=$4 bind=$5 pg_image=$6 node_image=$7 docker=$8 creators=$9 tls=${10:-}

fail() { echo "$*" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || fail "Máy chủ chưa có openssl (cần để sinh secret)."
$docker version >/dev/null 2>&1 || fail "Không gọi được '$docker' (chưa cài, hoặc user không thuộc nhóm docker: đặt HIVE_REMOTE_DOCKER=\"sudo docker\")."
$docker compose version >/dev/null 2>&1 || fail "Máy chủ chưa có docker compose v2."
[ -d "$dir/src.new" ] || fail "Không thấy mã nguồn vừa gửi ở $dir/src.new."
case "$tls" in ''|auto|dns-cloudflare) ;; *) fail "HIVE_TLS chỉ nhận auto hoặc dns-cloudflare." ;; esac

env=$dir/.env
umask 077
if [ ! -f "$env" ]; then
  [ -n "$public" ] || fail "Lần triển khai đầu cần HIVE_PUBLIC_URL (vd. HIVE_PUBLIC_URL=http://<máy-chủ>:3000)."
  : >"$env"
  echo "Tạo ${env} với secret mới."
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
get() { grep "^$1=" "$env" | tail -1 | cut -d= -f2-; }

# Mật khẩu nằm trong URL postgres nên dùng hex, không dùng base64 (có + / =).
for key in HIVE_DB_ADMIN_PASSWORD HIVE_DB_OWNER_PASSWORD HIVE_DB_APP_PASSWORD HIVE_DB_AUTH_PASSWORD HIVE_DB_JOBS_PASSWORD; do
  add "$key" "$(openssl rand -hex 24)"
done
add HIVE_AUTH_SECRET "$(openssl rand -base64 32)"
add HIVE_MASTER_KEY "$(openssl rand -base64 32)"
add HIVE_PORT 3000
[ -n "$project" ] && put HIVE_COMPOSE_PROJECT "$project"
add HIVE_COMPOSE_PROJECT xdev-hive
[ -n "$public" ] && put HIVE_PUBLIC_URL "$public"
[ -n "$bind" ] && put HIVE_BIND "$bind"
# Hub đặt sau Caddy bằng địa chỉ IP (https://<ip>): Caddy tự cấp chứng chỉ từ CA nội bộ và cần default_sni = IP đó.
host=$(printf '%s' "$(get HIVE_PUBLIC_URL)" | sed -nE 's#^https://([^/:]+).*#\1#p')
case "$host" in
  "")
    [ -z "$tls" ] || fail "HIVE_TLS chỉ dùng khi HIVE_PUBLIC_URL là https."
    has HIVE_TLS && put HIVE_TLS auto
    ;;
  *[!0-9.]*)
    [ -n "$tls" ] && put HIVE_TLS "$tls"
    # Tên miền của hub nội bộ không nhận được thử thách HTTP của Let's Encrypt; máy chủ public đặt HIVE_TLS=auto.
    add HIVE_TLS dns-cloudflare
    [ "$(get HIVE_TLS)" = auto ] || put COMPOSE_PROFILES https
    ;;
  *)
    [ "$tls" != dns-cloudflare ] || fail "HIVE_TLS=dns-cloudflare cần HIVE_PUBLIC_URL là tên miền; địa chỉ IP dùng CA nội bộ."
    has HIVE_TLS && put HIVE_TLS auto
    put HIVE_DEFAULT_SNI "$host"
    put COMPOSE_PROFILES https
    ;;
esac
[ -n "$pg_image" ] && put HIVE_POSTGRES_IMAGE "$pg_image"
[ -n "$node_image" ] && put HIVE_NODE_IMAGE "$node_image"
[ -n "$creators" ] && put HIVE_ORG_CREATORS "$creators"
[ -n "$(get HIVE_ORG_CREATORS)" ] || echo "Chưa đặt HIVE_ORG_CREATORS: hub chỉ nhận người được mời nên chưa ai vào được. Chạy lại với HIVE_ORG_CREATORS=<email quản trị>." >&2
project=$(get HIVE_COMPOSE_PROJECT)
# Token chỉ do người quản trị đặt thẳng vào .env trên máy chủ: qua tham số thì lọt vào lịch sử shell và ps.
# Kiểm dạng trước khi Caddy chạy vì module cloudflare in nguyên token sai dạng vào log. Không bao giờ in token.
if [ "$(get HIVE_TLS)" = dns-cloudflare ]; then
  cf_token=$(get CF_API_TOKEN)
  [ -n "$cf_token" ] || fail "HIVE_TLS=dns-cloudflare cần CF_API_TOKEN trong $env trên máy chủ (token Cloudflare chỉ có quyền Zone > Zone > Read và Zone > DNS > Edit, giới hạn ở zone của tên miền). Script không nhận token qua dòng lệnh: tự thêm dòng CF_API_TOKEN=<token> vào file đó (giữ quyền 600) theo docs/self-hosting.md, rồi chạy lại."
  # Cùng quy tắc với caddy-dns/cloudflare; grep của BSD không nhận số lặp trên 255 nên trần độ dài kiểm riêng.
  { [ "${#cf_token}" -le 261 ] && printf '%s\n' "$cf_token" | grep -Eqx '[A-Za-z0-9_-]{35,50}|cf(ut|at)_[A-Za-z0-9_-]{32,}'; } ||
    fail "CF_API_TOKEN trong $env không đúng dạng token Cloudflare (thừa nháy, dấu cách hay ký tự xuống dòng CRLF?). Sửa lại dòng đó trên máy chủ rồi chạy lại."
fi

# Thay mã cũ bằng mã mới; giữ bản trước ở src.old để xem lại khi cần.
rm -rf "$dir/src.old"
[ -d "$dir/src" ] && mv "$dir/src" "$dir/src.old"
mv "$dir/src.new" "$dir/src"
cd "$dir/src"

# -p luôn có: tên project quyết định container và volume nào là của bản này.
# Runner CI tự host cùng user có thể để builder buildx của job làm mặc định rồi xoá nó giữa lúc build (graceful_stop):
# luôn build bằng builder mặc định của Docker.
compose() { BUILDX_BUILDER=default HIVE_VERSION="${commit}" $docker compose -p "$project" --env-file "$env" -f deploy/compose.yaml "$@"; }
echo "Dựng và chạy hub (project ${project}) ở commit ${commit}…"
compose up -d --build

# src được đổi cả thư mục, nên mount file lẫn mount thư mục đều có thể giữ inode cũ.
# Đọc bản container đang thấy để sửa được cả các máy đã deploy nhưng chưa nạp Caddyfile mới.
caddy_id=$(compose ps -q caddy)
check_ca=0
case ",${COMPOSE_PROFILES:-$(get COMPOSE_PROFILES)}," in *,https,*) check_ca=1 ;; esac
if [ -n "$caddy_id" ]; then
  check_ca=1
  mounted_hash=$(compose exec -T caddy sha256sum /etc/caddy/Caddyfile) || fail "Không đọc được Caddyfile trong container."
  mounted_hash=${mounted_hash%% *}
  next_hash=$(openssl dgst -sha256 < deploy/caddy/Caddyfile)
  next_hash=${next_hash##* }
  if [ "$mounted_hash" != "$next_hash" ]; then
    echo "Caddyfile đã đổi; tạo lại container Caddy để gắn file mới…"
    compose up -d --no-deps --force-recreate caddy
  fi
fi

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
if [ "$check_ca" -eq 1 ]; then
  # IP: kiểm /ca.crt của CA nội bộ. Tên miền: kiểm chứng chỉ bằng CA hệ thống, chờ tới 2 phút cho Let's Encrypt.
  case "$host" in
    *[!0-9.]*) problem="chứng chỉ của $(get HIVE_PUBLIC_URL) chưa được CA hệ thống tin (tên miền chưa trỏ đúng, CF_API_TOKEN thiếu quyền, hoặc chứng chỉ chưa cấp xong)" ;;
    *) problem="/ca.crt chưa trả về chứng chỉ PEM hợp lệ" ;;
  esac
  if ! compose exec -T hub node --input-type=module - "$(get HIVE_PUBLIC_URL)" < deploy/check-ca.mjs; then
    echo "CẢNH BÁO: $problem. Kiểm tra cấu hình Caddy và log: docker compose -p $project --env-file $env -f $dir/src/deploy/compose.yaml logs --tail 80 caddy" >&2
  fi
fi
echo "Hub đang chạy ở commit ${commit}. Địa chỉ: $(get HIVE_PUBLIC_URL)"
REMOTE
