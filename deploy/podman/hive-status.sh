#!/usr/bin/env bash
# What an administrator asks first: is the hub up, which image and commit, how loaded, how full, and how the last
# deploys went. hive-status --check exits non-zero when the hub is not healthy (for a host-side monitor).
set -uo pipefail
# shellcheck source=deploy/podman/lib.sh
. /usr/local/lib/xdev-hive/lib.sh

healthy=0
curl -fsS --max-time 5 "http://127.0.0.1:$HIVE_PORT/api/health" 2>/dev/null | grep -q '"ok":true' && healthy=1
if [ "${1:-}" = "--check" ]; then [ "$healthy" = 1 ]; exit; fi

echo "== hub"
echo "health:        $([ "$healthy" = 1 ] && echo ok || echo NOT HEALTHY)"
echo "service:       $(systemctl is-active hive-hub.service) (seaweedfs: $(systemctl is-active hive-seaweedfs.service))"
echo "container:     $(podman inspect -f '{{.State.Status}} since {{.State.StartedAt}}, health {{.State.Health.Status}}' hive-hub 2>/dev/null || echo none)"
echo "image:         $(current_image)"
echo "commit:        $(state_get status revision)"
echo "schema:        $(state_get status schema)"
echo
echo "== deploys"
echo "last check:    $(state_get status last_check)"
echo "last success:  $(state_get status last_success)"
echo "last failure:  $(state_get status last_failure)"
echo "failures:      $(state_get status failures)"
echo "on hold:       $(tr '\n' ' ' <"$STATE/hold" 2>/dev/null)"
echo "prod now:      $(skopeo inspect --format '{{.Digest}}' "docker://$HIVE_IMAGE:$HIVE_CHANNEL" 2>/dev/null || echo 'cannot read')"
echo
echo "== resources"
podman stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>/dev/null
df -h "$HIVE_ROOT" | tail -n 1 | awk '{print "disk /srv/hive: " $3 " used of " $2 " (" $5 "), " $4 " free"}'
echo "database:      $(du -h "$HIVE_ROOT/data/hub.db" 2>/dev/null | cut -f1)"
echo "snapshots:     $(ls "$HIVE_ROOT"/backups/hub-*.db 2>/dev/null | wc -l) by the hub, $(ls "$DEPLOY_BACKUPS"/hub-*.db 2>/dev/null | wc -l) by deploys"
echo
echo "== history (newest last)"
tail -n 5 "$STATE/history.jsonl" 2>/dev/null
