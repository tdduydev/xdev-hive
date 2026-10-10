#!/usr/bin/env bash
# Deploys the hub image the prod tag points to, when it changed, on a Docker Compose host (cron runs it every two
# minutes; by hand: hive-deploy [--force] [--image <image@sha256:…>]). Pull-based: the host only reaches out to
# ghcr.io. Same steps as deploy/podman/hive-deploy.sh, on the compose project of deploy/compose.yaml:
#  1. prod → digest; nothing to do when it runs already, failed before, or is on hold after a rollback
#  2. pull by digest; amd64; label org.opencontainers.image.revision (only hub-image.yml builds with it)
#  3. free space; the repo checked out at that revision, so compose files match the image
#  4. stop the hub (one SQLite writer), snapshot with the hub's CLI (VACUUM INTO), verify integrity and schema
#  5. trial run on 127.0.0.1 only (no client can write): it migrates and must answer /api/health twice
#  6. the real start, pinned by digest (deploy/compose.image.yaml); healthy again
# A failed trial puts the snapshot back if it migrated, and starts the previous image. A failed real start goes back to
# the previous image when the schema did not change; otherwise the new one stays and the log says what to do
# (docs/deployment/docker-autodeploy.md), since clients may have written with the new schema.
set -Euo pipefail
# shellcheck source=deploy/docker/lib.sh
. "${HIVE_LIB:-$HOME/.local/lib/xdev-hive/lib.sh}"

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

mkdir -p "$STATE" "$LOGS"
exec 9>"$STATE/deploy.lock"
flock -n 9 || exit 0

# 1.
if [ -z "$target" ]; then
  digest=$(docker buildx imagetools inspect "$HIVE_IMAGE:$HIVE_CHANNEL" --format '{{json .Manifest.Digest}}' 2>>"$LOGS/deploy.log" | tr -d '"') ||
    { state_set status last_check_error "$(date -u +%FT%TZ) cannot read $HIVE_IMAGE:$HIVE_CHANNEL"; exit 1; }
  [ -n "$digest" ] || exit 1
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
on_error() {
  log "unexpected failure ($1)"
  if [ "$hub_stopped" = 1 ] && [ "$switched" = 0 ]; then
    docker rm -f hive-hub-verify >/dev/null 2>&1 || true
    [ -n "$current" ] && compose up -d --no-build hub >/dev/null 2>&1 || true
  fi
  exit 1
}
trap 'on_error "line $LINENO"' ERR
trap 'on_error signal' TERM INT

record_failure() {
  local stage=$1 why=$2 manual=${3:-}
  printf '%s\n' "$target" >>"$STATE/failed"
  state_set status last_failure "$(date -u +%FT%TZ) $stage: $why"
  state_set status failures "$(( $(state_get status failures) + 1 ))"
  history_add "{\"at\":\"$started\",\"result\":\"failed\",\"stage\":\"$stage\",\"image\":\"$target\",\"previous\":\"$current\",\"why\":\"$why\",\"manual\":\"$manual\"}"
  log "FAILED ($stage): $why"
  [ -n "$manual" ] && log "MANUAL RECOVERY NEEDED: $manual"
  return 0
}

# 2.
docker pull -q "$target" >/dev/null || { record_failure pull "cannot pull"; exit 1; }
arch=$(docker image inspect -f '{{.Architecture}}' "$target")
[ "$arch" = amd64 ] || { record_failure validate "architecture $arch, not amd64"; exit 1; }
revision=$(revision_of "$target")
[ -n "$revision" ] || { record_failure validate "no org.opencontainers.image.revision label: not built by hub-image.yml"; exit 1; }

# 3.
db_mb=$(docker run --rm --network none -v "$DATA_VOLUME:/data" --entrypoint sh "$target" -c 'du -m /data/hub.db 2>/dev/null | cut -f1' || echo 0)
root=$(docker info --format '{{.DockerRootDir}}')
free_mb=$(df -Pm "$root" 2>/dev/null | awk 'NR==2 {print $4}')
need_mb=$(( HIVE_MIN_FREE_MB + 3 * ${db_mb:-0} ))
[ "${free_mb:-0}" -ge "$need_mb" ] || { record_failure disk "${free_mb} MB free under $root, ${need_mb} MB needed"; exit 1; }
# Compose files of the image's own commit (a rollback brings its files back too). Only on a clean checkout.
if [ -z "$(cd "$HIVE_REPO" && git status --porcelain --untracked-files=no)" ]; then
  (cd "$HIVE_REPO" && git fetch -q origin && git checkout -q --detach "$revision") ||
    { record_failure validate "commit $revision not found in the repo at $HIVE_REPO"; exit 1; }
else
  log "repo at $HIVE_REPO has local changes: compose files left as they are"
fi

# 4.
compose up -d --no-build seaweedfs >/dev/null
schema_before=$(schema_of "$target")
compose stop hub >/dev/null 2>&1 || true
hub_stopped=1
docker rm -f hive-hub-verify >/dev/null 2>&1 || true
if docker run --rm --network none -v "$DATA_VOLUME:/data" --entrypoint test "$target" -f /data/hub.db; then
  backup=$(snapshot "$target")
  check=$(integrity_of "$target" "$backup")
  bschema=$(schema_of "$target" "$backup")
  if [ "$check" != ok ] || [ "$bschema" != "$schema_before" ]; then
    record_failure backup "snapshot $backup: integrity '$check', schema $bschema vs $schema_before"
    [ -n "$current" ] && compose up -d --no-build hub >/dev/null
    exit 1
  fi
  log "snapshot $backup (schema $schema_before, integrity ok)"
fi

# 5.
trial=$(mktemp "$HIVE_REPO/deploy/.compose.trial.XXXX.yaml")
write_override "$trial" "$target"
export HIVE_COMMIT=${revision:0:8}
compose_with "$trial" run -d --no-deps --name hive-hub-verify -p "127.0.0.1:$HIVE_VERIFY_PORT:7788" hub >/dev/null
trial_ok=0
if wait_port "$HIVE_VERIFY_PORT" "$HIVE_HEALTH_TIMEOUT" hive-hub-verify && sleep 15 && wait_port "$HIVE_VERIFY_PORT" 30 hive-hub-verify; then
  trial_ok=1
fi
docker logs hive-hub-verify >"$LOGS/trial-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
docker stop -t 60 hive-hub-verify >/dev/null 2>&1 || true
docker rm -f hive-hub-verify >/dev/null 2>&1 || true
schema_after=$(schema_of "$target")

back_to_previous() {
  if [ -n "$current" ]; then
    write_override "$OVERRIDE" "$current"
    HIVE_COMMIT=$(revision_of "$current"); export HIVE_COMMIT=${HIVE_COMMIT:0:8}
    if compose up -d --no-build hub lan >/dev/null && wait_hub "$HIVE_HEALTH_TIMEOUT"; then
      log "previous image running again: $current"; return 0
    fi
    return 1
  fi
  log "no previous image: the hub stays stopped"; return 1
}

if [ "$trial_ok" = 0 ]; then
  trap - ERR
  rm -f "$trial"
  if [ "$schema_after" != "$schema_before" ] && [ -n "$backup" ]; then
    # Only the trial wrote since the snapshot (loopback, no client), so putting it back loses nothing.
    restore_snapshot "$target" "$backup"
    restored=$(schema_of "$target")
    [ "$restored" = "$schema_before" ] || { record_failure trial "trial failed; restored schema $restored, expected $schema_before" "restore $backup by hand (docs/deployment/docker-autodeploy.md)"; exit 1; }
    log "trial migrated $schema_before → $schema_after; snapshot put back"
  fi
  if back_to_previous; then
    record_failure trial "no healthy answer from the new image (logs in $LOGS)"
  else
    record_failure trial "no healthy answer from the new image, and the previous one did not start" "docker compose logs hub; $LOGS"
  fi
  exit 1
fi

# 6.
mv -f "$trial" "$OVERRIDE"
switched=1
trap - ERR
if compose up -d --no-build hub lan >/dev/null && wait_hub "$HIVE_HEALTH_TIMEOUT"; then
  state_set status current "$target"
  state_set status previous "$current"
  state_set status revision "$revision"
  state_set status schema "$schema_after"
  state_set status last_success "$(date -u +%FT%TZ)"
  printf '%s %s\n' "$target" "$schema_after" >>"$STATE/schemas"
  grep -vxF "$target" "$STATE/failed" >"$STATE/failed.tmp" 2>/dev/null || true
  mv -f "$STATE/failed.tmp" "$STATE/failed"
  history_add "{\"at\":\"$started\",\"result\":\"deployed\",\"image\":\"$target\",\"revision\":\"$revision\",\"previous\":\"$current\",\"schema\":[$schema_before,$schema_after],\"backup\":\"$backup\"}"
  docker images --digests --format '{{.Repository}}@{{.Digest}}' | grep -F "$HIVE_IMAGE@" | grep -vxF -e "$target" -e "${current:-none}" |
    xargs -r docker rmi >/dev/null 2>&1 || true
  prune_snapshots "$target" "$HIVE_DEPLOY_BACKUP_KEEP" || true
  log "deployed $target (commit $revision, schema $schema_before → $schema_after)"
  # A warning, not a rollback: the hub answers on its other ports, and the CA's volume is not in the image.
  if fp=$(lan_https_check); then
    [ -n "$fp" ] && log "LAN https ok (root CA sha256 $fp)"
  else
    log "WARNING: LAN https does not verify with its own CA (docs/deployment/lan-https.md)"
  fi
  exit 0
fi

compose logs --no-color --tail 200 hub >"$LOGS/start-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
if [ "$schema_after" = "$schema_before" ]; then
  compose stop hub >/dev/null 2>&1 || true
  if back_to_previous; then
    record_failure start "passed the trial but not the real start; previous image back (same schema)"
  else
    record_failure start "passed the trial but not the real start; previous image did not start either" "docker compose logs hub; $LOGS"
  fi
else
  if [ -n "$backup" ]; then
    manual="hive-rollback --previous --restore-backup $backup --accept-data-loss (writes since the deploy are lost; a snapshot of them is taken first)"
  else
    manual="first deploy, nothing to go back to: docker compose logs hub, fix, then hive-deploy --force"
  fi
  record_failure start "passed the trial but not the real start; schema $schema_before → $schema_after, left running" "$manual"
fi
exit 1
