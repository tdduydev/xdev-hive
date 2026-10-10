#!/usr/bin/env bash
# Puts an earlier hub image back by hand on a Docker Compose host, and holds the automatic deploy off the image it
# replaces. Same rules as deploy/podman/hive-rollback.sh:
#   hive-rollback --previous | --to <image@sha256:…>   [--restore-backup <snapshot in the volume> --accept-data-loss]
# An image only runs on a database whose schema it knew (state/schemas). Going back past a migration means putting a
# snapshot from before it back, which loses every write since: that needs both flags, and the current database is
# snapshotted first. Snapshot paths are as hive-deploy logs them: /data/backups/deploy/hub-….db.
set -Euo pipefail
# shellcheck source=deploy/docker/lib.sh
. "${HIVE_LIB:-$HOME/.local/lib/xdev-hive/lib.sh}"

to=""
restore=""
accept=0
while [ $# -gt 0 ]; do
  case "$1" in
    --previous) to=$(state_get status previous) ;;
    --to) to=$2; shift ;;
    --restore-backup) restore=$2; shift ;;
    --accept-data-loss) accept=1 ;;
    *) echo "usage: hive-rollback (--previous | --to <image@sha256:…>) [--restore-backup <file> --accept-data-loss]" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$to" ] || die "no target image (state has no previous image; use --to)"
[[ "$to" == *@sha256:* ]] || die "roll back by digest only: $to"

mkdir -p "$STATE" "$LOGS"
exec 9>"$STATE/deploy.lock"
flock -w 600 9 || die "a deploy is running; try again when it ends"

current=$(current_image)
docker image inspect "$to" >/dev/null 2>&1 || docker pull -q "$to" >/dev/null || die "cannot pull $to"
if [ -n "$restore" ]; then
  docker run --rm --network none -v "$BACKUP_VOLUME:/data/backups" --entrypoint test "$to" -f "$restore" || die "no snapshot $restore in the backups volume"
fi
schema_now=$(schema_of "$to")
schema_to=$(awk -v i="$to" '$1 == i {s = $2} END {print s}' "$STATE/schemas" 2>/dev/null)
log "rollback to $to (running: ${current:-none}; database schema $schema_now; target last ran at schema ${schema_to:-unknown})"

if [ -z "$restore" ]; then
  [ -n "$schema_to" ] || die "$to never ran here, so its schema is unknown: add --restore-backup <snapshot from when it ran> --accept-data-loss"
  [ "$schema_now" -le "$schema_to" ] || die "the database has schema $schema_now, newer than $schema_to of $to. Image-only rollback refused: pick the deploy snapshot from before the upgrade (hive-status lists them) and add --restore-backup <it> --accept-data-loss"
else
  [ "$accept" = 1 ] || die "--restore-backup replaces the database: writes since that snapshot are lost. Add --accept-data-loss to go on."
fi

compose stop hub >/dev/null 2>&1 || true
if [ -n "$restore" ]; then
  kept=$(snapshot "$to")
  log "database before the restore kept as $kept"
  restore_snapshot "$to" "$restore"
  log "restored $restore (schema $(schema_of "$to"))"
fi

# The compose files of that image's commit, as a deploy would use.
rev=$(revision_of "$to")
if [ -n "$rev" ] && [ -z "$(cd "$HIVE_REPO" && git status --porcelain --untracked-files=no)" ]; then
  (cd "$HIVE_REPO" && git fetch -q origin && git checkout -q --detach "$rev") || true
fi
export HIVE_COMMIT=${rev:0:8}
write_override "$OVERRIDE" "$to"
compose up -d --no-build hub lan >/dev/null || true
if wait_hub "$HIVE_HEALTH_TIMEOUT"; then
  [ -n "$current" ] && printf '%s\n' "$current" >>"$STATE/hold"
  state_set status current "$to"
  state_set status previous "$current"
  state_set status schema "$(schema_of "$to")"
  state_set status revision "$rev"
  history_add "{\"at\":\"$(date -u +%FT%TZ)\",\"result\":\"rolled-back\",\"image\":\"$to\",\"from\":\"$current\",\"restored\":\"$restore\"}"
  log "rolled back to $to; the deploy holds off $current until prod points elsewhere (or remove it from $STATE/hold)"
  exit 0
fi
die "$to did not become healthy; see: docker compose -p $HIVE_PROJECT logs hub"
