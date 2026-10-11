ARG NODE_IMAGE=node:24.21-bookworm-slim
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/corepack
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @xdev-hive/web build

FROM build AS runtime
ENV NODE_ENV=production HIVE_PORT=3000 HIVE_WEB_DIST=/repo/apps/web/dist
EXPOSE 3000
CMD ["sh", "-c", "if [ -n \"$HIVE_DATABASE_ADMIN_URL\" ]; then pnpm --filter @xdev-hive/hub db:bootstrap; fi && pnpm --filter @xdev-hive/hub db:migrate && pnpm --filter @xdev-hive/hub start"]
