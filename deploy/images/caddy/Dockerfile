# Caddy for the hub's LAN port (deploy/compose.lan.yaml) and its HTTPS front (deploy/compose.yaml), rebuilt from the
# same upstream release with a current Go toolchain: the official caddy image of that release is built with an older
# Go and golang.org/x/net, and the vulnerability scan (deps-images.yml) refuses it. Built and pushed by
# .github/workflows/deps-images.yml as ghcr.io/tdduydev/xdev-hive-caddy:<version>.
ARG GO_IMAGE=mirror.gcr.io/library/golang:1.27-alpine
ARG BASE_IMAGE=mirror.gcr.io/library/alpine:3
FROM ${GO_IMAGE} AS build
ARG CADDY_VERSION=v2.11.7
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch "${CADDY_VERSION}" https://github.com/caddyserver/caddy.git .
# The golang.org/x modules the scan flags, raised to their newest releases; go build proves they still fit.
RUN go get golang.org/x/net@latest golang.org/x/crypto@latest golang.org/x/text@latest golang.org/x/sys@latest \
  && go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/caddy ./cmd/caddy && /out/caddy version

FROM ${BASE_IMAGE}
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates mailcap
COPY --from=build /out/caddy /usr/bin/caddy
# Where the official image keeps them, so the compose files' volumes and Caddyfile paths stay the same.
ENV XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
RUN mkdir -p /config/caddy /data/caddy /etc/caddy /usr/share/caddy
VOLUME /config /data
EXPOSE 80 443 443/udp 2019
WORKDIR /srv
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
