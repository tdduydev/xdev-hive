#!/usr/bin/env bash
# Updates a hub deployed from this repo to origin/main and waits until it answers again. Run on the server:
#   bash deploy/update.sh                    (Caddy: deploy/compose.yaml)
#   HIVE_TUNNEL=1 bash deploy/update.sh      (Cloudflare Tunnel: + deploy/compose.tunnel.yaml)
# From another machine: ssh <server> 'HIVE_TUNNEL=1 bash ~/path/to/xdev-hive/deploy/update.sh'
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin main
git merge -q --ff-only origin/main
echo "code: $(git log --oneline -1)"

files=(-f deploy/compose.yaml)
if [ "${HIVE_TUNNEL:-}" = "1" ]; then files+=(-f deploy/compose.tunnel.yaml); fi
# The hub backs up its database on start, before any schema migration of the new version.
docker compose -p "${HIVE_PROJECT:-xdev-hive}" "${files[@]}" up -d --build hub

container="$(docker compose -p "${HIVE_PROJECT:-xdev-hive}" "${files[@]}" ps -q hub)"
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
