#!/usr/bin/env bash
# Puts an earlier hub image back by hand, and holds the automatic deploy off the image it replaces.
#   hive-rollback --previous                                 the image before the running one
#   hive-rollback --to <image@sha256:…>                       any image that ran here before
#   … --restore-backup <snapshot.db> --accept-data-loss       also put a database snapshot back
#
# An image only runs on a database whose schema it knows. When the running database has more migrations than the
# target image had when it last ran here (state/schemas), the image alone is refused: going back then means putting
# back a snapshot from before those migrations, and everything written since that snapshot is lost. That needs both
# --restore-backup and --accept-data-loss, and the current database is snapshotted first, so it can be recovered.
# Docs: docs/deployment/backup-restore.md.
set -Euo pipefail
# shellcheck source=deploy/podman/lib.sh
. /usr/local/lib/xdev-hive/lib.sh

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
[ -z "$restore" ] || [ -f "$restore" ] || die "no snapshot $restore"

mkdir -p "$STATE" "$LOGS" "$DEPLOY_BACKUPS"
exec 9>/run/lock/hive-deploy.lock
flock -w 600 9 || die "a deploy is running; try again when it ends"

current=$(current_image)
podman image exists "$to" || podman pull -q "$to" >/dev/null || die "cannot pull $to"
schema_now=$(schema_of "$to")
schema_to=$(awk -v i="$to" '$1 == i {s = $2} END {print s}' "$STATE/schemas" 2>/dev/null)
log "rollback to $to (running: ${current:-none}; database schema $schema_now; target last ran at schema ${schema_to:-unknown})"

if [ -z "$restore" ]; then
  if [ -z "$schema_to" ]; then
    die "$to never ran here, so its schema is unknown: roll back with --restore-backup <snapshot from when it ran> --accept-data-loss"
  fi
  if [ "$schema_now" -gt "$schema_to" ]; then
    die "the database has schema $schema_now, newer than $schema_to of $to. Image-only rollback refused. Pick the deploy snapshot from before the upgrade (ls -t $DEPLOY_BACKUPS) and add --restore-backup <it> --accept-data-loss"
  fi
else
  [ "$accept" = 1 ] || die "--restore-backup replaces the database: writes since that snapshot are lost. Add --accept-data-loss to go on."
fi

systemctl stop hive-hub.service || true
podman rm -f hive-hub hive-hub-verify >/dev/null 2>&1 || true

if [ -n "$restore" ]; then
  # What is there now is kept first, so the writes being rolled away can still be read back by hand.
  if [ -f "$HIVE_ROOT/data/hub.db" ]; then
    out=$(podman run --rm --network none --user 1000:1000 -w /app/apps/web \
      -v "$HIVE_ROOT/data:/data:Z" -v "$HIVE_ROOT/backups:/data/backups:Z" -e HIVE_DB=/data/hub.db \
      --entrypoint node "$to" src/cli.ts backup /data/backups/deploy 1000)
    out=$(printf '%s\n' "$out" | sed -n 1p)
    log "database before the restore kept as $HIVE_ROOT/backups/${out#/data/backups/}"
  fi
  tmp="$HIVE_ROOT/data/.restore.$$"
  cp "$restore" "$tmp"
  rm -f "$HIVE_ROOT/data/hub.db-wal" "$HIVE_ROOT/data/hub.db-shm"
  mv -f "$tmp" "$HIVE_ROOT/data/hub.db"
  chown 1000:1000 "$HIVE_ROOT/data/hub.db"
  restorecon "$HIVE_ROOT/data/hub.db" 2>/dev/null || true
  log "restored $restore (schema $(schema_of "$to"))"
fi

write_hub_unit "$to"
systemctl start hive-hub.service || true
if wait_healthy "$HIVE_PORT" "$HIVE_HEALTH_TIMEOUT"; then
  # The automatic deploy would bring the image back at once while prod still points to it.
  [ -n "$current" ] && printf '%s\n' "$current" >>"$STATE/hold"
  state_set status current "$to"
  state_set status previous "$current"
  state_set status schema "$(schema_of "$to")"
  history_add "{\"at\":\"$(date -u +%FT%TZ)\",\"result\":\"rolled-back\",\"image\":\"$to\",\"from\":\"$current\",\"restored\":\"$restore\"}"
  log "rolled back to $to; the deploy holds off $current until prod points elsewhere (or remove it from $STATE/hold)"
  exit 0
fi
die "$to did not become healthy; see journalctl -u hive-hub"
