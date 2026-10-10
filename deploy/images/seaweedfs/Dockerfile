# SeaweedFS for the hub's doc files (deploy/compose.yaml), rebuilt from the same upstream release with a current Go
# toolchain: the official chrislusf/seaweedfs image of that release carries an older Go and golang.org/x/net that the
# vulnerability scan refuses. Same `weed` binary and data format; only the Go build differs. Built and pushed by
# .github/workflows/deps-images.yml as ghcr.io/tdduydev/xdev-hive-seaweedfs:<version>.
ARG GO_IMAGE=mirror.gcr.io/library/golang:1.27-alpine
ARG BASE_IMAGE=mirror.gcr.io/library/alpine:3
FROM ${GO_IMAGE} AS build
ARG SEAWEEDFS_VERSION=4.48
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch "${SEAWEEDFS_VERSION}" https://github.com/seaweedfs/seaweedfs.git .
RUN go get golang.org/x/net@latest golang.org/x/crypto@latest golang.org/x/text@latest golang.org/x/sys@latest \
  && go mod tidy
RUN cd weed && CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=$(git rev-parse --short HEAD)" \
    -o /out/weed . && /out/weed version

FROM ${BASE_IMAGE}
# curl: the compose health check (curl http://127.0.0.1:8888/), as with the official image.
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates curl
COPY --from=build /out/weed /usr/bin/weed
RUN mkdir -p /data
VOLUME /data
WORKDIR /data
EXPOSE 8080 8888 9333 18080 18888 19333
# compose gives `server -dir=/data -filer …` as the command.
ENTRYPOINT ["/usr/bin/weed"]
CMD ["server", "-dir=/data", "-filer"]
