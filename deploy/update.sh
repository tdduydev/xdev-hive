#!/usr/bin/env bash
# Updates a hub deployed from this repo to origin/main and waits until it answers again. Run on the server:
#   bash deploy/update.sh                    (Caddy: deploy/compose.yaml)
#   HIVE_TUNNEL=1 bash deploy/update.sh      (Cloudflare Tunnel: + deploy/compose.tunnel.yaml)
#   HIVE_LAN=1 bash deploy/update.sh         (a port for the LAN too: + deploy/compose.lan.yaml; combines with the above)
# From another machine: ssh <server> 'HIVE_TUNNEL=1 bash ~/path/to/xdev-hive/deploy/update.sh'
set -euo pipefail
cd "$(dirname "$0")/.."

# Bash goes on reading the file it started with: once the pull brings a new version of this script,
# run that one for the rest (the Ollama step came in this way and only ran on the second deploy).
if [ -z "${HIVE_UPDATE_PULLED:-}" ]; then
  git fetch -q origin main
  git merge -q --ff-only origin/main
  echo "code: $(git log --oneline -1)"
  HIVE_UPDATE_PULLED=1 exec bash deploy/update.sh "$@"
fi

# A setting as compose sees it: the environment first, then deploy/.env.
env_value() { printf '%s' "$(sed -n "s/^$1=//p" deploy/.env 2>/dev/null | tail -n 1)"; }

files=(-f deploy/compose.yaml)
services=(hub)
if [ "${HIVE_TUNNEL:-}" = "1" ]; then files+=(-f deploy/compose.tunnel.yaml); fi
if [ "${HIVE_LAN:-}" = "1" ]; then
  # The LAN port (roadmap 43) is a second Caddy in front of the same hub: it has to be started along with it.
  files+=(-f deploy/compose.lan.yaml)
  services+=(lan)
  if [ -z "${HIVE_LAN_HOSTS:-$(env_value HIVE_LAN_HOSTS)}" ]; then
    echo "HIVE_LAN=1 needs HIVE_LAN_HOSTS in deploy/.env: the names and addresses machines on the LAN type, e.g. 10.86.140.52,my-server" >&2
    exit 1
  fi
# compose.yaml no longer demands HIVE_HOSTNAME (a hub that lives on the LAN alone has no domain), so ask here:
# without one and without a LAN port the hub would answer to any name, and the public Caddy has no site address.
elif [ -z "${HIVE_HOSTNAME:-$(env_value HIVE_HOSTNAME)}" ]; then
  echo "set HIVE_HOSTNAME (e.g. hive.example.com) in deploy/.env, or HIVE_LAN=1 with HIVE_LAN_HOSTS for a hub on the LAN only" >&2
  exit 1
fi
compose=(docker compose -p "${HIVE_PROJECT:-xdev-hive}" "${files[@]}")

# Embeddings for memory search (COMPOSE_PROFILES=embed in deploy/.env): Ollama next to the hub, model pulled first.
# Never in the way of the hub update: without the model, memory search matches words only.
if "${compose[@]}" config --services | grep -qx ollama; then
  model="${HIVE_EMBED_MODEL:-$(sed -n 's/^HIVE_EMBED_MODEL=//p' deploy/.env 2>/dev/null | tail -n 1)}"
  model="${model:-bge-m3}"
  if "${compose[@]}" up -d ollama; then
    for _ in $(seq 1 30); do "${compose[@]}" exec -T ollama ollama list >/dev/null 2>&1 && break; sleep 1; done
    # Quick when the model is there already.
    if "${compose[@]}" exec -T ollama ollama pull "$model" >/dev/null; then
      echo "embeddings: $model ready"
    else
      echo "embeddings: could not pull $model; memory search matches words only until it is there" >&2
    fi
  else
    echo "embeddings: Ollama did not start; memory search matches words only" >&2
  fi
fi
# Images from Docker Hub (SeaweedFS, and Caddy for the LAN port this run starts): when it refuses
# (429 on some servers), the same image from Google's mirror of it, tagged with the name compose asks for.
ensure_image() {
  local image="$1" mirror
  docker image inspect "$image" >/dev/null 2>&1 && return 0
  docker pull -q "$image" >/dev/null 2>&1 && return 0
  case "$image" in */*) mirror="mirror.gcr.io/$image" ;; *) mirror="mirror.gcr.io/library/$image" ;; esac
  echo "images: Docker Hub refused $image, pulling $mirror" >&2
  docker pull -q "$mirror" >/dev/null && docker tag "$mirror" "$image"
}
wanted='seaweedfs'
if [ "${HIVE_LAN:-}" = "1" ]; then wanted='seaweedfs|caddy'; fi
for image in $("${compose[@]}" config --images | grep -iE "$wanted" || true); do
  ensure_image "$image" || echo "images: could not pull $image" >&2
done

# The hub backs up its database on start, before any schema migration of the new version.
# Its Hub page shows the commit it runs.
export HIVE_COMMIT="$(git rev-parse --short HEAD)"
"${compose[@]}" up -d --build "${services[@]}"

container="$("${compose[@]}" ps -q hub)"
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = "healthy" ]; then
    echo "hub healthy"
    exit 0
  fi
  sleep 2
done
echo "hub did not become healthy; recent logs:" >&2
docker logs --tail 40 "$container" >&2
exit 1
