#!/usr/bin/env bash
# Shared by the hive-* scripts of deploy/docker (installed to ~/.local/lib/xdev-hive/lib.sh by install.sh). They run on
# a Linux host with Docker Compose, as a user in the docker group, against the compose project of deploy/compose.yaml.

HIVE_CONFIG=${HIVE_CONFIG:-$HOME/.config/xdev-hive/deploy.env}
# shellcheck source=/dev/null
[ -r "$HIVE_CONFIG" ] && . "$HIVE_CONFIG"
HIVE_REPO=${HIVE_REPO:-$HOME/xdev-hive}
HIVE_PROJECT=${HIVE_PROJECT:-xdev-hive}
HIVE_IMAGE=${HIVE_IMAGE:-ghcr.io/tdduydev/xdev-hive}
HIVE_CHANNEL=${HIVE_CHANNEL:-prod}
HIVE_VERIFY_PORT=${HIVE_VERIFY_PORT:-17788}
HIVE_HEALTH_TIMEOUT=${HIVE_HEALTH_TIMEOUT:-180}
HIVE_MIN_FREE_MB=${HIVE_MIN_FREE_MB:-2048}
HIVE_DEPLOY_BACKUP_KEEP=${HIVE_DEPLOY_BACKUP_KEEP:-10}
# Compose files besides deploy/compose.yaml: the LAN port by default; add deploy/compose.tunnel.yaml for a tunnel.
HIVE_COMPOSE_EXTRA=${HIVE_COMPOSE_EXTRA:-deploy/compose.lan.yaml}
STATE=${HIVE_STATE:-$HOME/.local/state/xdev-hive}
LOGS=$STATE/logs
OVERRIDE=$HIVE_REPO/deploy/compose.image.yaml
DATA_VOLUME=${HIVE_PROJECT}_hive-data
BACKUP_VOLUME=${HIVE_PROJECT}_hive-backups

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOGS/deploy.log" >&2; }
die() { log "ERROR: $*"; exit 1; }

state_get() { sed -n "s/^$2=//p" "$STATE/$1" 2>/dev/null | tail -n 1; }
state_set() {
  local file=$STATE/$1 tmp
  tmp=$(mktemp "$STATE/.tmp.XXXX")
  { grep -v "^$2=" "$file" 2>/dev/null || true; printf '%s=%s\n' "$2" "$3"; } >"$tmp"
  mv -f "$tmp" "$file"
}
history_add() { printf '%s\n' "$1" >>"$STATE/history.jsonl"; }

# docker compose for the hub, with the image pinned by <override> (default: the one in place).
compose_with() {
  local override=$1; shift
  local files=(-f deploy/compose.yaml)
  for f in $HIVE_COMPOSE_EXTRA; do files+=(-f "$f"); done
  [ -f "$override" ] && files+=(-f "$override")
  (cd "$HIVE_REPO" && docker compose -p "$HIVE_PROJECT" "${files[@]}" "$@")
}
compose() { compose_with "$OVERRIDE" "$@"; }

# Pins the hub's image by digest; compose's `build:` is then never used on this host.
write_override() {
  printf '# Written by hive-deploy: the hub image that passed its checks, by digest. Not part of the repo.\nservices:\n  hub:\n    image: %s\n    pull_policy: never\n' "$2" >"$1"
}
current_image() { sed -n 's/^    image: //p' "$OVERRIDE" 2>/dev/null | head -n 1; }

# node:sqlite in <image> against the hub's volumes, read-only, no network.
in_volumes() {
  local image=$1; shift
  docker run --rm --network none --user 1000:1000 -v "$DATA_VOLUME:/data" -v "$BACKUP_VOLUME:/data/backups" --entrypoint node "$image" "$@"
}
# PRAGMA user_version of a database in the volumes (how many of the hub's migrations it has); 0 when absent.
schema_of() {
  in_volumes "$1" -e '
    const fs = require("node:fs"); const f = process.argv[1];
    if (!fs.existsSync(f)) { console.log(0); process.exit(0); }
    const { DatabaseSync } = require("node:sqlite");
    console.log(new DatabaseSync(f, { readOnly: true }).prepare("PRAGMA user_version").get().user_version);' "${2:-/data/hub.db}"
}
integrity_of() {
  in_volumes "$1" -e '
    const { DatabaseSync } = require("node:sqlite");
    console.log(new DatabaseSync(process.argv[1], { readOnly: true }).prepare("PRAGMA integrity_check").get().integrity_check);' "$2"
}
# A snapshot by the hub's own CLI (VACUUM INTO); prints its path in the volume (/data/backups/deploy/hub-….db).
snapshot() {
  local out
  out=$(docker run --rm --network none --user 1000:1000 -w /app/apps/web -e HIVE_DB=/data/hub.db \
    -v "$DATA_VOLUME:/data" -v "$BACKUP_VOLUME:/data/backups" --entrypoint node "$1" src/cli.ts backup /data/backups/deploy 1000)
  printf '%s\n' "$out" | sed -n 1p
}
# Puts a snapshot (path in the volume) back as hub.db, with the WAL of the newer database gone.
restore_snapshot() {
  docker run --rm --network none --user 1000:1000 -v "$DATA_VOLUME:/data" -v "$BACKUP_VOLUME:/data/backups" --entrypoint sh "$1" \
    -c 'cp "$0" /data/.restore && rm -f /data/hub.db-wal /data/hub.db-shm && mv -f /data/.restore /data/hub.db' "$2"
}
prune_snapshots() {
  docker run --rm --network none --user 1000:1000 -v "$BACKUP_VOLUME:/data/backups" --entrypoint sh "$1" \
    -c 'ls -1t /data/backups/deploy/hub-*.db 2>/dev/null | tail -n +"$(($0 + 1))" | while read -r f; do rm -f "$f" "$f.json"; done' "$2"
}

# 0 when the hub answers {"ok":true} on 127.0.0.1:<port> within <seconds>; the container must keep running meanwhile.
wait_port() {
  local port=$1 seconds=$2 container=${3:-} end=$((SECONDS + $2))
  while [ $SECONDS -lt $end ]; do
    if [ -n "$container" ] && [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != true ]; then
      log "$container is not running"; return 1
    fi
    curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true' && return 0
    sleep 3
  done
  log "no healthy answer on 127.0.0.1:$port within ${seconds}s"; return 1
}
# 0 when the compose hub container is healthy (its image's HEALTHCHECK) within <seconds>.
wait_hub() {
  local end=$((SECONDS + $1)) id status
  while [ $SECONDS -lt $end ]; do
    id=$(compose ps -q hub 2>/dev/null)
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  log "the hub container is not healthy after ${1}s (last: ${status:-none})"; return 1
}

# The commit an image says it was built from (hub-image.yml sets the label).
revision_of() { docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null; }

# The LAN HTTPS port (compose.lan.yaml) as a machine on the LAN sees it: the root CA the lan service serves must verify
# the certificate it presents (curl --cacert). Prints the CA's SHA-256 on success. Nothing to check when there is no LAN port.
lan_https_check() {
  local host port ca
  host=$(sed -n 's/^HIVE_LAN_HOSTS=//p' "$HIVE_REPO/deploy/.env" 2>/dev/null | tail -n 1 | tr ', ' '\n\n' | sed '/^$/d' | head -n 1)
  [ -n "$host" ] || return 0
  port=$(sed -n 's/^HIVE_LAN_HTTPS_PORT=//p' "$HIVE_REPO/deploy/.env" 2>/dev/null | tail -n 1)
  port=${port:-7743}
  ca=$(mktemp)
  # --insecure only to read the public root certificate; the check itself is the second curl, with that CA as the only trust.
  curl -fsS --max-time 10 --insecure "https://$host:$port/ca.crt" -o "$ca" &&
    curl -fsS --max-time 10 --cacert "$ca" -o /dev/null "https://$host:$port/api/health" &&
    grep -v -- '-----' "$ca" | base64 -d | sha256sum | cut -d' ' -f1
  local rc=$?
  rm -f "$ca"
  return $rc
}
