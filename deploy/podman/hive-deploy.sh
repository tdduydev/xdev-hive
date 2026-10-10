#!/usr/bin/env bash
# Deploys the hub image that the prod tag points to, when it changed (run every two minutes by hive-deploy.timer;
# by hand: hive-deploy [--force] [--image <image@sha256:…>]). Pull-based: the VM only reaches out to ghcr.io, nothing
# reaches in. Docs: docs/deployment/podman-production.md.
#
# Steps, each one able to stop the deploy with the old hub still in place:
#  1. resolve prod to a digest; nothing to do when it is the one running, or one that failed or is on hold
#  2. pull it by digest, check its architecture, label and (optionally) its GitHub build attestation
#  3. check free space
#  4. stop the hub (one writer on SQLite), snapshot the database with the hub's own CLI (VACUUM INTO), verify it
#  5. trial run of the new image on a loopback-only port: it migrates the database and must answer /api/health,
#     while no client can reach it, so a failed trial loses no one's writes and the snapshot can be put back
#  6. the real start, by digest, under systemd; health again on the published port
# A failure in 5 puts the snapshot back if the trial migrated the schema, and starts the previous image. A failure
# in 6 goes back to the previous image only when the schema did not change; otherwise it leaves the new one to
# systemd and says what a person has to do (docs/deployment/backup-restore.md), since clients may have written.
set -Euo pipefail
# shellcheck source=deploy/podman/lib.sh
. /usr/local/lib/xdev-hive/lib.sh

force=0
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --image) target=$2; shift ;;
    *) echo "usage: hive-deploy [--force] [--image <image@sha256:digest>]" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$STATE" "$LOGS" "$DEPLOY_BACKUPS"
exec 9>/run/lock/hive-deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 0; }

# 1. What prod points to.
if [ -z "$target" ]; then
  digest=$(skopeo inspect --format '{{.Digest}}' "docker://$HIVE_IMAGE:$HIVE_CHANNEL" 2>>"$LOGS/deploy.log") ||
    { state_set status last_check_error "$(date -u +%FT%TZ) cannot read $HIVE_IMAGE:$HIVE_CHANNEL"; exit 1; }
  target="$HIVE_IMAGE@$digest"
fi
[[ "$target" == *@sha256:* ]] || die "deploy by digest only: $target"
state_set status last_check "$(date -u +%FT%TZ)"
current=$(current_image)
if [ "$target" = "$current" ] && [ "$force" = 0 ]; then exit 0; fi
if [ "$force" = 0 ] && grep -qxF "$target" "$STATE/failed" 2>/dev/null; then exit 0; fi
if [ "$force" = 0 ] && grep -qxF "$target" "$STATE/hold" 2>/dev/null; then exit 0; fi

started=$(date -u +%FT%TZ)
log "deploy $target (running: ${current:-none})"

hub_stopped=0
switched=0
backup=""
schema_before=""
# Anything unexpected after the hub was stopped and before the new one runs: the old one goes back.
on_error() {
  local line=$1
  log "unexpected failure at line $line"
  if [ "$hub_stopped" = 1 ] && [ "$switched" = 0 ]; then
    podman rm -f hive-hub-verify >/dev/null 2>&1 || true
    [ -n "$current" ] && systemctl start hive-hub.service || true
  fi
  exit 1
}
trap 'on_error $LINENO' ERR

record_failure() {
  local stage=$1 why=$2 manual=${3:-}
  printf '%s\n' "$target" >>"$STATE/failed"
  state_set status last_failure "$(date -u +%FT%TZ) $stage: $why"
  state_set status failures "$(( $(state_get status failures || echo 0) + 1 ))"
  history_add "{\"at\":\"$started\",\"result\":\"failed\",\"stage\":\"$stage\",\"image\":\"$target\",\"previous\":\"$current\",\"why\":\"$why\",\"manual\":\"$manual\"}"
  log "FAILED ($stage): $why"
  [ -n "$manual" ] && log "MANUAL RECOVERY NEEDED: $manual"
}

# 2. The image itself.
podman pull -q "$target" >/dev/null || { record_failure pull "cannot pull"; exit 1; }
arch=$(podman image inspect -f '{{.Architecture}}' "$target")
[ "$arch" = amd64 ] || { record_failure validate "architecture $arch, not amd64"; exit 1; }
revision=$(podman image inspect -f '{{index .Labels "org.opencontainers.image.revision"}}' "$target" 2>/dev/null || true)
[ -n "$revision" ] && [ "$revision" != "<no value>" ] || { record_failure validate "no org.opencontainers.image.revision label: not built by hub-image.yml"; exit 1; }
if [ "$HIVE_REQUIRE_ATTESTATION" = 1 ]; then
  GH_TOKEN=${HIVE_GH_TOKEN:-} gh attestation verify "oci://$target" --repo "${HIVE_GH_REPO:-tdduydev/xdev-hive}" >>"$LOGS/deploy.log" 2>&1 ||
    { record_failure validate "no valid build provenance attestation"; exit 1; }
fi

# 3. Room for a snapshot, the trial's migration and the image.
db_mb=$(( $(stat -c %s "$HIVE_ROOT/data/hub.db" 2>/dev/null || echo 0) / 1048576 ))
free_mb=$(df -Pm "$HIVE_ROOT" | awk 'NR==2 {print $4}')
need_mb=$(( HIVE_MIN_FREE_MB + 3 * db_mb ))
[ "$free_mb" -ge "$need_mb" ] || { record_failure disk "${free_mb} MB free on $HIVE_ROOT, ${need_mb} MB needed"; exit 1; }

# 4. One writer: the running hub stops before anything opens the database.
systemctl start hive-network.service hive-seaweedfs.service
schema_before=$(schema_of "$target")
if systemctl is-active -q hive-hub.service; then
  systemctl stop hive-hub.service
fi
hub_stopped=1
podman rm -f hive-hub hive-hub-verify >/dev/null 2>&1 || true
if [ -f "$HIVE_ROOT/data/hub.db" ]; then
  out=$(podman run --rm --network none --user 1000:1000 -w /app/apps/web \
    -v "$HIVE_ROOT/data:/data:Z" -v "$HIVE_ROOT/backups:/data/backups:Z" -e HIVE_DB=/data/hub.db \
    --entrypoint node "$target" src/cli.ts backup /data/backups/deploy 1000)
  # The CLI prints the snapshot first, then what its rotation removed.
  out=$(printf '%s\n' "$out" | sed -n 1p)
  backup="$HIVE_ROOT/backups/${out#/data/backups/}"
  [ -f "$backup" ] || { record_failure backup "no snapshot written ($out)"; systemctl start hive-hub.service || true; exit 1; }
  check=$(integrity_of "$target" "$out")
  bschema=$(schema_of "$target" "$out")
  if [ "$check" != ok ] || [ "$bschema" != "$schema_before" ]; then
    record_failure backup "snapshot $backup: integrity '$check', schema $bschema vs $schema_before"
    [ -n "$current" ] && systemctl start hive-hub.service || true
    exit 1
  fi
  log "snapshot $backup (schema $schema_before, integrity ok)"
fi

# 5. Trial on loopback only.
restore_snapshot() {
  local tmp="$HIVE_ROOT/data/.restore.$$"
  cp --preserve=mode "$backup" "$tmp"
  rm -f "$HIVE_ROOT/data/hub.db-wal" "$HIVE_ROOT/data/hub.db-shm"
  mv -f "$tmp" "$HIVE_ROOT/data/hub.db"
  chown 1000:1000 "$HIVE_ROOT/data/hub.db"
  restorecon "$HIVE_ROOT/data/hub.db" 2>/dev/null || true
}
back_to_previous() {
  if [ -n "$current" ]; then
    write_hub_unit "$current"
    if systemctl start hive-hub.service && wait_healthy "$HIVE_PORT" "$HIVE_HEALTH_TIMEOUT"; then
      log "previous image running again: $current"
      return 0
    fi
    return 1
  fi
  log "no previous image: the hub stays stopped"
  return 1
}

podman run -d --name hive-hub-verify --network hive --user 1000:1000 \
  --env-file "$HIVE_ETC/hub.env" -e HIVE_SEAWEEDFS_URL=http://hive-seaweedfs:8888 \
  -v "$HIVE_ROOT/data:/data:Z" -v "$HIVE_ROOT/backups:/data/backups:Z" \
  -p "127.0.0.1:$HIVE_VERIFY_PORT:7788" --read-only --cap-drop ALL --security-opt no-new-privileges \
  "$target" >/dev/null
trial_ok=0
# Healthy, and still healthy a little later: a hub that answers once and then crashes does not pass.
if wait_healthy "$HIVE_VERIFY_PORT" "$HIVE_HEALTH_TIMEOUT" hive-hub-verify && sleep 15 && wait_healthy "$HIVE_VERIFY_PORT" 30 hive-hub-verify; then
  trial_ok=1
fi
podman logs hive-hub-verify >"$LOGS/trial-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
podman stop -t 60 hive-hub-verify >/dev/null 2>&1 || true
podman rm -f hive-hub-verify >/dev/null 2>&1 || true
schema_after=$(schema_of "$target")

if [ "$trial_ok" = 0 ]; then
  if [ "$schema_after" != "$schema_before" ] && [ -n "$backup" ]; then
    # Only the trial wrote since the snapshot (loopback, no client), so putting it back loses nothing.
    restore_snapshot
    restored=$(schema_of "$target")
    [ "$restored" = "$schema_before" ] || { record_failure trial "trial failed; restored schema $restored, expected $schema_before" "restore $backup by hand (docs/deployment/backup-restore.md)"; exit 1; }
    log "trial migrated $schema_before → $schema_after; snapshot put back"
  fi
  trap - ERR
  if back_to_previous; then
    record_failure trial "no healthy answer from the new image (logs in $LOGS)"
  else
    record_failure trial "no healthy answer from the new image, and the previous one did not start" "see journalctl -u hive-hub and $LOGS"
  fi
  exit 1
fi

# 6. The real start, by digest.
write_hub_unit "$target"
switched=1
trap - ERR
if timeout "$((HIVE_HEALTH_TIMEOUT + 120))" systemctl start hive-hub.service && wait_healthy "$HIVE_PORT" "$HIVE_HEALTH_TIMEOUT"; then
  state_set status current "$target"
  state_set status previous "$current"
  state_set status revision "$revision"
  state_set status schema "$schema_after"
  state_set status last_success "$(date -u +%FT%TZ)"
  printf '%s %s\n' "$target" "$schema_after" >>"$STATE/schemas"
  grep -vxF "$target" "$STATE/failed" >"$STATE/failed.tmp" 2>/dev/null || true
  mv -f "$STATE/failed.tmp" "$STATE/failed"
  history_add "{\"at\":\"$started\",\"result\":\"deployed\",\"image\":\"$target\",\"revision\":\"$revision\",\"previous\":\"$current\",\"schema\":[$schema_before,$schema_after],\"backup\":\"$backup\"}"
  # Images other than the running one and the one before it, and old deploy snapshots.
  podman images --format '{{.Repository}}@{{.Digest}}' | grep -F "$HIVE_IMAGE@" | grep -vxF -e "$target" -e "${current:-none}" |
    xargs -r podman rmi >/dev/null 2>&1 || true
  prune_deploy_backups "$HIVE_DEPLOY_BACKUP_KEEP"
  log "deployed $target (commit $revision, schema $schema_before → $schema_after)"
  exit 0
fi

journalctl -u hive-hub.service -n 200 --no-pager >"$LOGS/start-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
if [ "$schema_after" = "$schema_before" ]; then
  systemctl stop hive-hub.service || true
  if back_to_previous; then
    record_failure start "passed the trial but not the real start; previous image back (same schema)"
  else
    record_failure start "passed the trial but not the real start; previous image did not start either" "see journalctl -u hive-hub and $LOGS"
  fi
else
  # Clients may have written with the new schema already: no automatic restore over their data.
  record_failure start "passed the trial but not the real start; schema $schema_before → $schema_after, left to systemd" \
    "hive-rollback --previous --restore-backup $backup --accept-data-loss (writes since the deploy are lost; a snapshot of them is taken first)"
fi
exit 1
