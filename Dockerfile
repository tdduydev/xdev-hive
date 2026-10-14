ARG NODE_IMAGE=node:24.21-bookworm-slim
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
EXPOSE 3000
# Không chạy bằng root. Gọi node trực tiếp (không qua pnpm) vì corepack cần ghi cache mà user node không có quyền.
USER node
WORKDIR /repo/apps/hub
CMD ["sh", "-c", "if [ -n \"$HIVE_DATABASE_ADMIN_URL\" ]; then node src/cli.ts db:bootstrap; fi && node src/cli.ts db:migrate && exec node src/main.ts"]
