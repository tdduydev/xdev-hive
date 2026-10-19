ARG NODE_IMAGE=node:24.21-bookworm-slim

# pandoc cho nhập Word (spec 019, ADR 0029). Kho Debian chỉ có 2.17, quá cũ cho bộ lọc: lấy binary tĩnh của bản phát hành
# chính thức, ghim phiên bản và SHA-256. Đổi phiên bản thì sửa cả ba ARG (CI đọc từ đây) và chạy lại test vàng.
# SHA-256 lấy từ trường "digest" của asset trên https://github.com/jgm/pandoc/releases/tag/3.12.
FROM ${NODE_IMAGE} AS pandoc
ARG TARGETARCH
ARG PANDOC_VERSION=3.12
ARG PANDOC_SHA256_AMD64=67d7d011fed8c8543306022b985b9b2499ab9b74818df91d8727c7e9ebc5ba06
ARG PANDOC_SHA256_ARM64=6cefcf7100e23a99447c26f89d1ff5b253f3407fcef99a9e27ae06f3ed16cb82
WORKDIR /pandoc
# Máy chủ không ra được GitHub thì đặt sẵn tarball vào deploy/vendor/ (gitignore) trước khi dựng; checksum vẫn kiểm như
# bản tải. Image node slim không có curl nên tải bằng fetch của node.
RUN --mount=type=bind,source=deploy,target=/ctx/deploy \
    set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64; sum=$PANDOC_SHA256_AMD64 ;; \
      arm64) arch=arm64; sum=$PANDOC_SHA256_ARM64 ;; \
      *) echo "pandoc không có bản cho kiến trúc $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    file=pandoc-$PANDOC_VERSION-linux-$arch.tar.gz; \
    if [ -f "/ctx/deploy/vendor/$file" ]; then \
      cp "/ctx/deploy/vendor/$file" .; \
    else \
      node -e 'const [url, file] = process.argv.slice(1); fetch(url).then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); require("node:fs").writeFileSync(file, Buffer.from(await r.arrayBuffer())); })' \
        "https://github.com/jgm/pandoc/releases/download/$PANDOC_VERSION/$file" "$file"; \
    fi; \
    echo "$sum  $file" | sha256sum -c -; \
    tar -xzf "$file" --strip-components=2 "pandoc-$PANDOC_VERSION/bin/pandoc"; \
    rm "$file"

FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/corepack
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @xdev-hive/web build
# Thư viện của khung artifact (dist/lib), hub phục vụ ở /_artifact/lib/.
RUN pnpm --filter @xdev-hive/artifacts-runtime build
# Giờ dựng image: hub trả trong /api/v1/health (builtAt) để web hiện "build ngày …".
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /repo/BUILD_TIME

FROM build AS runtime
ENV NODE_ENV=production HIVE_PORT=3000 HIVE_WEB_DIST=/repo/apps/web/dist
COPY --from=pandoc /pandoc/pandoc /usr/local/bin/pandoc
# Hỏng ngay lúc dựng nếu binary không chạy được trên kiến trúc này.
RUN pandoc --version
EXPOSE 3000
# Không chạy bằng root. Gọi node trực tiếp (không qua pnpm) vì corepack cần ghi cache mà user node không có quyền.
USER node
WORKDIR /repo/apps/hub
CMD ["sh", "-c", "if [ -n \"$HIVE_DATABASE_ADMIN_URL\" ]; then node src/cli.ts db:bootstrap; fi && node src/cli.ts db:migrate && exec node src/main.ts"]
