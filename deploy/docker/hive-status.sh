#!/usr/bin/env bash
# The hub on this Docker host at a glance: health, image and commit, load, space, deploys. --check: exit status only.
set -uo pipefail
# shellcheck source=deploy/docker/lib.sh
. "${HIVE_LIB:-$HOME/.local/lib/xdev-hive/lib.sh}"

id=$(compose ps -q hub 2>/dev/null)
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)
if [ "${1:-}" = "--check" ]; then [ "$health" = healthy ]; exit; fi

image=$(current_image)
echo "== hub"
echo "health:        ${health:-not running}"
echo "image:         ${image:-none}"
echo "commit:        $(state_get status revision)"
echo "built:         $(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$image" 2>/dev/null)"
echo "schema:        $(state_get status schema)"
echo "lan https:     $(lan_https_check 2>/dev/null | sed 's/^/ok, root CA sha256 /' | grep . || echo 'not verifying, or no LAN port')"
echo
echo "== deploys"
echo "last check:    $(state_get status last_check)"
echo "last success:  $(state_get status last_success)"
echo "last failure:  $(state_get status last_failure)"
echo "failures:      $(state_get status failures)"
echo "on hold:       $(tr '\n' ' ' <"$STATE/hold" 2>/dev/null)"
echo "prod now:      $(docker buildx imagetools inspect "$HIVE_IMAGE:$HIVE_CHANNEL" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')"
echo
echo "== resources"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $(compose ps -q 2>/dev/null) 2>/dev/null
root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
df -h "$root" | tail -n 1 | awk '{print "disk " $6 ": " $3 " used of " $2 " (" $5 "), " $4 " free"}'
[ -n "$image" ] && docker run --rm --network none -v "$DATA_VOLUME:/data" -v "$BACKUP_VOLUME:/data/backups" --entrypoint sh "$image" \
  -c 'echo "database:      $(du -h /data/hub.db | cut -f1)"; echo "snapshots:     $(ls /data/backups/hub-*.db 2>/dev/null | wc -l) by the hub, $(ls /data/backups/deploy/hub-*.db 2>/dev/null | wc -l) by deploys (newest: $(ls -1t /data/backups/deploy/hub-*.db 2>/dev/null | head -n 1))"'
echo
echo "== history (newest last)"
tail -n 5 "$STATE/history.jsonl" 2>/dev/null
