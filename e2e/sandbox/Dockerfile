ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24.21-bookworm-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/e2e-fake-cli.ts scripts/e2e-sandbox-probe.ts /opt/hive/
USER node
WORKDIR /workspace
