#!/bin/sh
# Dựng image Caddy của cả hai chế độ HIVE_TLS rồi validate Caddyfile bằng biến giả. Cần Docker và mạng để tải image,
# module Go; không gọi Cloudflare hay Let's Encrypt (validate không chạy ACME).
set -eu
repo=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
docker=${HIVE_TEST_DOCKER:-docker}
tag=xdev-hive-caddy-test
# Đúng dạng token Cloudflare để module chấp nhận, nhưng không phải token thật.
fake_token=cfut_00000000000000000000000000000000test
fail() { echo "Kiểm tra thất bại: $*" >&2; exit 1; }

for target in auto dns-cloudflare; do
  $docker build -q --target "$target" -t "$tag:$target" "$repo/deploy/caddy" >/dev/null
done
$docker run --rm "$tag:dns-cloudflare" caddy list-modules | grep -qx dns.providers.cloudflare ||
  fail 'Image dns-cloudflare thiếu module dns.providers.cloudflare.'
if $docker run --rm "$tag:auto" caddy list-modules | grep -q '^dns\.providers\.'; then
  fail 'Image auto phải là caddy gốc, không có module DNS.'
fi
$docker run --rm "$tag:dns-cloudflare" caddy version | grep -q '^v2\.11\.7 ' || fail 'Image dns-cloudflare sai bản Caddy.'

# adapt <image> <HIVE_TLS> <HIVE_PUBLIC_URL> <HIVE_DEFAULT_SNI>: validate rồi in cấu hình JSON đã chuyển đổi.
adapt() {
  $docker run --rm -i -e HIVE_TLS="$2" -e HIVE_PUBLIC_URL="$3" -e HIVE_DEFAULT_SNI="$4" -e CF_API_TOKEN="$fake_token" \
    "$tag:$1" sh -c 'cat >/etc/caddy/Caddyfile &&
      caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>/tmp/err || { tail -1 /tmp/err >&2; exit 1; }
      caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null' <"$repo/deploy/caddy/Caddyfile"
}

# auto chạy được trên image caddy gốc: snippet dns-cloudflare không được import nên không cần module.
json=$(adapt auto auto https://192.0.2.34 192.0.2.34) || fail 'Caddyfile auto với IP không hợp lệ.'
case "$json" in *'"/ca.crt"'*) ;; *) fail 'Site IP thiếu /ca.crt.' ;; esac
case "$json" in *cloudflare*) fail 'Chế độ auto vẫn dùng DNS-01.' ;; esac
adapt auto auto https://hive.example.com localhost >/dev/null || fail 'Caddyfile auto với tên miền không hợp lệ.'

json=$(adapt dns-cloudflare dns-cloudflare https://hive.example.test 192.0.2.34) ||
  fail 'Caddyfile dns-cloudflare không hợp lệ.'
# Tên miền lấy Let's Encrypt qua DNS-01, không tự hỏi DNS ra ngoài (mạng nội bộ hay chặn); IP cũ vẫn có CA nội bộ.
printf '%s' "$json" | grep -q '"subjects":\["hive.example.test"\],"issuers":\[{"challenges":{"dns":{"propagation_delay":60000000000,"propagation_timeout":-1,"provider":{"api_token":"{env.CF_API_TOKEN}","name":"cloudflare"}}' ||
  fail 'Tên miền chưa dùng DNS-01 Cloudflare với bước chờ cố định.'
printf '%s' "$json" | grep -q '"subjects":\["192.0.2.34"\],"issuers":\[{"module":"internal"}\]' ||
  fail 'Thiếu site IP dùng CA nội bộ.'
printf '%s' "$json" | grep -q '"host":\["192.0.2.34"\]' || fail 'Thiếu route cho site IP.'
# Token chỉ đọc lúc chạy ({env.…}), không nằm trong cấu hình mà Caddy có thể ghi ra log hay /config.
case "$json" in *"$fake_token"*) fail 'Token lọt vào cấu hình đã chuyển đổi.' ;; esac
if adapt auto dns-cloudflare https://hive.example.test 192.0.2.34 >/dev/null 2>&1; then
  fail 'Image auto nhận chế độ dns-cloudflare dù thiếu module.'
fi

# compose dựng đúng target theo HIVE_TLS.
config() {
  HIVE_TLS=$1 $docker compose --env-file "$repo/deploy/.env.example" -f "$repo/deploy/compose.yaml" --profile https \
    config caddy
}
config dns-cloudflare | grep -q 'target: dns-cloudflare' || fail 'compose không dựng target dns-cloudflare.'
config '' | grep -q 'target: auto' || fail 'compose không mặc định target auto.'
echo 'Đạt: image auto/dns-cloudflare, module cloudflare, Caddyfile auto (IP, tên miền) và dns-cloudflare (kèm site IP), target compose.'
