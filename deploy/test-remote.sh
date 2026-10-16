#!/bin/sh
# Docker giả giữ file đang mount riêng để tái hiện inode cũ qua nhiều lần thay src.
set -eu
repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "$repo/.env.remote-test.XXXXXX")
export REMOTE_TEST_TMP="$tmp"
cleanup() { python3 -c 'import os, shutil; shutil.rmtree(os.environ["REMOTE_TEST_TMP"])'; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$tmp/bin"
export PATH="$tmp/bin:$PATH" MOCK_LOG="$tmp/docker.log" MOCK_MOUNT="$tmp/mounted-Caddyfile"
export MOCK_CA_CODE=0 MOCK_CADDY=1 MOCK_READ_FAIL=0 MOCK_RECREATE_FAIL=0
export MOCK_DIR="$tmp/máy chủ's"
mkdir -p "$MOCK_DIR"
cat >"$MOCK_DIR/.env" <<'ENV'
HIVE_PUBLIC_URL=https://192.0.2.34
HIVE_COMPOSE_PROJECT=remote-test
HIVE_ORG_CREATORS=admin@example.com
ENV
# Chỉ chạy phần remote trong fixture; không gọi SSH, archive hay Docker thật.
sed "1,/^ssh .*<<'REMOTE'$/d; /^REMOTE$/d" "$repo/deploy/remote.sh" >"$tmp/remote.sh"
cat >"$tmp/bin/rm" <<'MOCK'
#!/bin/sh
set -eu
[ "$#" -eq 2 ] && [ "$1" = -rf ] && [ "$2" = "$MOCK_DIR/src.old" ] || exit 1
python3 -c 'import os, shutil; shutil.rmtree(os.environ["MOCK_DIR"] + "/src.old", ignore_errors=True)'
MOCK
cat >"$tmp/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$MOCK_LOG"
case "$1" in
  version) exit 0 ;;
  inspect) echo healthy; exit 0 ;;
esac
[ "$1" = compose ] || exit 1
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--env-file|-f) shift 2 ;;
    *) break ;;
  esac
done
case "$*" in
  version) : ;;
  'up -d --build')
    if [ "$MOCK_CADDY" = 1 ] && [ ! -f "$MOCK_MOUNT" ]; then cp deploy/caddy/Caddyfile "$MOCK_MOUNT"; fi
    ;;
  'up -d --no-deps --force-recreate caddy')
    [ "$MOCK_RECREATE_FAIL" = 0 ] || exit 1
    cp deploy/caddy/Caddyfile "$MOCK_MOUNT"
    ;;
  'ps -q caddy') [ "$MOCK_CADDY" = 0 ] || echo test-caddy ;;
  'ps -q hub') echo test-hub ;;
  'exec -T caddy sha256sum /etc/caddy/Caddyfile')
    [ "$MOCK_READ_FAIL" = 0 ] || exit 1
    digest=$(openssl dgst -sha256 <"$MOCK_MOUNT")
    printf '%s  /etc/caddy/Caddyfile\n' "$(printf '%s' "$digest" | sed 's/.* //')"
    ;;
  'exec -T hub node --input-type=module - '*) cat >/dev/null; exit "$MOCK_CA_CODE" ;;
  'exec -T hub node -e '*) echo '{"ok":true}' ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$tmp/bin/"*
fail() { echo "Kiểm tra thất bại: $*" >&2; exit 1; }
prepare() {
  mkdir -p "$MOCK_DIR/src.new/deploy/caddy"
  cp "$repo/deploy/caddy/Caddyfile" "$MOCK_DIR/src.new/deploy/caddy/"
  cp "$repo/deploy/check-ca.mjs" "$MOCK_DIR/src.new/deploy/"
  : >"$MOCK_LOG"
}
deploy() { sh "$tmp/remote.sh" "$MOCK_DIR" test-commit '' "${MOCK_PUBLIC:-}" '' '' '' docker '' "${MOCK_TLS:-}" >"$tmp/output" 2>&1; }
env_has() { grep -qx "$1" "$MOCK_DIR/.env"; }
no_recreate() {
  if grep -q force-recreate "$MOCK_LOG"; then fail 'Caddy đã bị tạo lại khi không cần.'; fi
}

prepare
deploy
no_recreate
grep -q 'node --input-type=module - https://192.0.2.34' "$MOCK_LOG" || fail 'Thiếu kiểm tra CA khi bật HTTPS.'
prepare
deploy
no_recreate
# Bản trên đĩa đã mới nhưng mount vẫn cũ, giống máy đã gặp lỗi trước bản sửa này.
printf '# cấu hình cũ\n' >"$MOCK_MOUNT"
prepare
deploy
grep -q 'up -d --no-deps --force-recreate caddy' "$MOCK_LOG" || fail 'Chưa tạo lại Caddy khi hash đổi.'
cmp -s "$MOCK_MOUNT" "$MOCK_DIR/src/deploy/caddy/Caddyfile" || fail 'Mount chưa nhận file mới.'
prepare
deploy
no_recreate
# Kể cả chỉ khác newline, hash phải nhận ra thay đổi byte.
printf '\n' >>"$MOCK_MOUNT"
prepare
deploy
grep -q force-recreate "$MOCK_LOG" || fail 'Hash bỏ qua newline.'
prepare
MOCK_READ_FAIL=1
if deploy; then fail 'Deploy vẫn thành công khi không đọc được mount.'; fi
MOCK_READ_FAIL=0
no_recreate
printf '# cấu hình cũ\n' >"$MOCK_MOUNT"
prepare
MOCK_RECREATE_FAIL=1
if deploy; then fail 'Deploy vẫn thành công khi không tạo lại được Caddy.'; fi
MOCK_RECREATE_FAIL=0
prepare
MOCK_CA_CODE=1
deploy
grep -q 'CẢNH BÁO: /ca.crt' "$tmp/output" || fail 'Thiếu cảnh báo CA.'
grep -q 'logs --tail 80 caddy' "$tmp/output" || fail 'Thiếu hướng dẫn xem log.'
prepare
MOCK_CADDY=0
deploy
no_recreate
grep -q 'CẢNH BÁO: /ca.crt' "$tmp/output" || fail 'Bỏ qua kiểm tra CA khi HTTPS bật nhưng Caddy không chạy.'
sed '/^COMPOSE_PROFILES=/d; s#https://192.0.2.34#http://192.0.2.34:3000#' "$MOCK_DIR/.env" >"$tmp/http.env"
mv "$tmp/http.env" "$MOCK_DIR/.env"
prepare
deploy
no_recreate
if grep -qE 'sha256sum|node --input-type=module' "$MOCK_LOG"; then fail 'Kiểm tra Caddy dù tắt HTTPS.'; fi

# Tên miền trỏ về IP nội bộ: mặc định DNS-01 qua Cloudflare, token chỉ đọc từ .env và không bao giờ in ra.
cat >"$MOCK_DIR/.env" <<'ENV'
HIVE_PUBLIC_URL=https://192.0.2.34
HIVE_DEFAULT_SNI=192.0.2.34
COMPOSE_PROFILES=https
HIVE_COMPOSE_PROJECT=remote-test
HIVE_ORG_CREATORS=admin@example.com
ENV
MOCK_PUBLIC=https://hive.example.test
prepare
if deploy; then fail 'Deploy chế độ DNS vẫn chạy khi thiếu CF_API_TOKEN.'; fi
grep -q 'cần CF_API_TOKEN' "$tmp/output" || fail 'Thiếu hướng dẫn đặt CF_API_TOKEN.'
if grep -q 'up -d' "$MOCK_LOG"; then fail 'Đã chạy compose khi thiếu token.'; fi
env_has HIVE_TLS=dns-cloudflare || fail 'Tên miền chưa bật chế độ dns-cloudflare.'
env_has COMPOSE_PROFILES=https || fail 'Tên miền chưa bật profile https.'
# Site IP cũ chạy song song trong lúc chuyển nhờ default_sni giữ nguyên.
env_has HIVE_DEFAULT_SNI=192.0.2.34 || fail 'Mất HIVE_DEFAULT_SNI của địa chỉ IP cũ.'
bad_token='"bi-mat-sai-dang-1234567890"'
printf 'CF_API_TOKEN=%s\n' "$bad_token" >>"$MOCK_DIR/.env"
prepare
if deploy; then fail 'Deploy vẫn chạy khi token sai dạng.'; fi
grep -q 'không đúng dạng' "$tmp/output" || fail 'Thiếu lỗi token sai dạng.'
if grep -q 'bi-mat' "$tmp/output"; then fail 'Đã in token ra output.'; fi
token=cfut_bimatthatbimatthatbimatthatbimatthat
sed '/^CF_API_TOKEN=/d' "$MOCK_DIR/.env" >"$tmp/token.env"
printf 'CF_API_TOKEN=%s\n' "$token" >>"$tmp/token.env"
mv "$tmp/token.env" "$MOCK_DIR/.env"
MOCK_PUBLIC=
prepare
deploy
grep -q 'node --input-type=module - https://hive.example.test' "$MOCK_LOG" || fail 'Thiếu kiểm chứng chỉ tên miền.'
if grep -q "$token" "$tmp/output" "$MOCK_LOG"; then fail 'Đã in token ra output.'; fi
prepare
MOCK_CA_CODE=1
deploy
grep -q 'CẢNH BÁO: chứng chỉ của https://hive.example.test chưa được CA hệ thống tin' "$tmp/output" || fail 'Thiếu cảnh báo chứng chỉ tên miền.'
if grep -q '/ca.crt' "$tmp/output"; then fail 'Tên miền vẫn nhắc /ca.crt.'; fi
MOCK_CA_CODE=0
MOCK_TLS=bogus
prepare
if deploy; then fail 'Nhận HIVE_TLS lạ.'; fi
MOCK_TLS=dns-cloudflare MOCK_PUBLIC=https://192.0.2.34
prepare
if deploy; then fail 'Nhận dns-cloudflare cho địa chỉ IP.'; fi
# Quay lại IP thì Caddy phải về CA nội bộ.
MOCK_TLS=
prepare
deploy
env_has HIVE_TLS=auto || fail 'Quay lại IP nhưng vẫn giữ chế độ dns-cloudflare.'
# Máy chủ public: HIVE_TLS=auto không cần token và không tự bật Caddy.
cat >"$MOCK_DIR/.env" <<'ENV'
HIVE_COMPOSE_PROJECT=remote-test
HIVE_ORG_CREATORS=admin@example.com
ENV
MOCK_TLS=auto MOCK_PUBLIC=https://hive.example.test
prepare
deploy
env_has HIVE_TLS=auto || fail 'Không lưu HIVE_TLS=auto.'
if grep -q '^COMPOSE_PROFILES=' "$MOCK_DIR/.env"; then fail 'HIVE_TLS=auto tự bật profile https.'; fi
echo 'Đạt: deploy đầu, hash giữ nguyên/đổi, mount cũ, newline, lỗi đọc/tạo lại, cảnh báo CA, Caddy không chạy, HTTPS tắt và tên miền (DNS-01, token thiếu/sai dạng, quay lại IP, auto).'
