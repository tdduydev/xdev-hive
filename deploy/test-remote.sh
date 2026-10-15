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
deploy() { sh "$tmp/remote.sh" "$MOCK_DIR" test-commit '' '' '' '' '' docker '' >"$tmp/output" 2>&1; }
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
echo 'Đạt: deploy đầu, hash giữ nguyên/đổi, mount cũ, newline, lỗi đọc/tạo lại, cảnh báo CA, Caddy không chạy và HTTPS tắt.'
