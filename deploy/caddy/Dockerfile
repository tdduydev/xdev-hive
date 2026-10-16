# compose chọn target theo HIVE_TLS. BuildKit chỉ dựng stage mà target cần; builder cũ dừng ở stage target, nên
# stage auto đứng đầu: chế độ auto dùng nguyên image caddy gốc, không tải Go hay module nào.
ARG CADDY_IMAGE=caddy:2.11.7
ARG CADDY_BUILDER_IMAGE=caddy:2.11.7-builder

FROM ${CADDY_IMAGE} AS auto

FROM ${CADDY_BUILDER_IMAGE} AS build-dns-cloudflare
# Ghim cả bản Caddy lẫn module để mỗi lần deploy dựng lại đúng cùng một binary.
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM ${CADDY_IMAGE} AS dns-cloudflare
COPY --from=build-dns-cloudflare /usr/bin/caddy /usr/bin/caddy
