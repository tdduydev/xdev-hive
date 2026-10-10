# xDev Hive hub (web UI, JSON RPC, MCP over HTTP) with its SQLite database on /data.
#   docker build -t xdev-hive-hub .
#   docker run -d -p 7788:7788 -v hive-data:/data -e HIVE_ALLOWED_HOSTS=hive.example.com xdev-hive-hub
# One container per database: SQLite does not share a file between replicas.
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Every workspace manifest, so `npm ci` matches the lockfile; the desktop app's sources stay out.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/ui/package.json packages/ui/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --workspace @xdev-hive/web --include-workspace-root --no-audit --no-fund
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build -w @xdev-hive/web

FROM node:${NODE_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production \
    HIVE_HOST=0.0.0.0 \
    HIVE_PORT=7788 \
    HIVE_DB=/data/hub.db \
    HIVE_BACKUP_DIR=/data/backups
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/ui/package.json packages/ui/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# npm itself goes once the dependencies are in: the hub runs node only, and the npm bundled with the base image
# carries its own dependencies (and their CVEs) into every image.
RUN npm ci --omit=dev --workspace @xdev-hive/web --include-workspace-root --no-audit --no-fund && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# The server runs TypeScript directly (Node type stripping), so sources ship as they are.
COPY packages/core/src packages/core/src
COPY packages/mcp/src packages/mcp/src
# Webhook messages use the interface's translations (no React in there).
COPY packages/ui-kit/src/i18n packages/ui-kit/src/i18n
COPY apps/web/src apps/web/src
COPY --from=build /app/apps/web/dist apps/web/dist
# Both exist in the image so new named volumes start out owned by `node` (uid 1000).
RUN mkdir -p /data/backups && chown -R node:node /data
# What was built and when (hub-image.yml passes them), for the Hub page, the web's status bar and /api/health. Last,
# since they change on every build: no layer above is rebuilt for them. A HIVE_COMMIT set at run time wins; compose sets
# it, often to "", so HIVE_BUILD_COMMIT keeps the image's own. Left out (docker build, compose build) the hub says "dev build".
ARG HIVE_COMMIT=
ARG HIVE_BUILD_DATE=
ARG HIVE_BUILD_VERSION=
ENV HIVE_COMMIT=${HIVE_COMMIT}     HIVE_BUILD_COMMIT=${HIVE_COMMIT}     HIVE_BUILD_DATE=${HIVE_BUILD_DATE}     HIVE_BUILD_VERSION=${HIVE_BUILD_VERSION}
USER node
VOLUME /data
EXPOSE 7788
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["node", "apps/web/src/healthcheck.ts"]
CMD ["node", "apps/web/src/server.ts"]
