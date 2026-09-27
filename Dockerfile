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
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev --workspace @xdev-hive/web --include-workspace-root --no-audit --no-fund && npm cache clean --force
# The server runs TypeScript directly (Node type stripping), so sources ship as they are.
COPY packages/core/src packages/core/src
COPY packages/mcp/src packages/mcp/src
COPY apps/web/src apps/web/src
COPY --from=build /app/apps/web/dist apps/web/dist
# Both exist in the image so new named volumes start out owned by `node` (uid 1000).
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 7788
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HIVE_PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/src/server.ts"]
