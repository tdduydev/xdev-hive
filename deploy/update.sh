#!/usr/bin/env bash
# Updates a hub deployed from this repo to origin/main and waits until it answers again. Run on the server:
#   bash deploy/update.sh                    (Caddy: deploy/compose.yaml)
#   HIVE_TUNNEL=1 bash deploy/update.sh      (Cloudflare Tunnel: + deploy/compose.tunnel.yaml)
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

files=(-f deploy/compose.yaml)
if [ "${HIVE_TUNNEL:-}" = "1" ]; then files+=(-f deploy/compose.tunnel.yaml); fi
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
# The hub backs up its database on start, before any schema migration of the new version.
# Its Hub page shows the commit it runs.
export HIVE_COMMIT="$(git rev-parse --short HEAD)"
"${compose[@]}" up -d --build hub

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
