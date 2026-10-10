#!/usr/bin/env bash
# Shared by the hive-* scripts of this folder (installed to /usr/local/lib/xdev-hive/lib.sh). Bash on the Linux VM
# that runs the hub under Podman; nothing here runs on the Windows host.

HIVE_ROOT=${HIVE_ROOT:-/srv/hive}
HIVE_ETC=${HIVE_ETC:-/etc/xdev-hive}
QUADLET_DIR=${QUADLET_DIR:-/etc/containers/systemd}
SHARE_DIR=${SHARE_DIR:-/usr/local/share/xdev-hive}
STATE=$HIVE_ROOT/state
LOGS=$HIVE_ROOT/logs
DEPLOY_BACKUPS=$HIVE_ROOT/backups/deploy

# shellcheck source=/dev/null
[ -r "$HIVE_ETC/deploy.env" ] && . "$HIVE_ETC/deploy.env"
HIVE_IMAGE=${HIVE_IMAGE:-ghcr.io/tdduydev/xdev-hive}
HIVE_CHANNEL=${HIVE_CHANNEL:-prod}
HIVE_PORT=${HIVE_PORT:-7788}
HIVE_VERIFY_PORT=${HIVE_VERIFY_PORT:-17788}
HIVE_HEALTH_TIMEOUT=${HIVE_HEALTH_TIMEOUT:-180}
HIVE_MIN_FREE_MB=${HIVE_MIN_FREE_MB:-2048}
HIVE_DEPLOY_BACKUP_KEEP=${HIVE_DEPLOY_BACKUP_KEEP:-10}
HIVE_REQUIRE_ATTESTATION=${HIVE_REQUIRE_ATTESTATION:-0}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOGS/deploy.log" >&2; }
die() { log "ERROR: $*"; exit 1; }

# key=value lines in $STATE/<name>; a value never holds a newline.
state_get() { sed -n "s/^$2=//p" "$STATE/$1" 2>/dev/null | tail -n 1; }
state_set() {
  local file=$STATE/$1 tmp
  tmp=$(mktemp "$STATE/.tmp.XXXX")
  { grep -v "^$2=" "$file" 2>/dev/null || true; printf '%s=%s\n' "$2" "$3"; } >"$tmp"
  mv -f "$tmp" "$file"
}
# One JSON object per line: every deploy, rollback and failure, for hive-status and for people.
history_add() { printf '%s\n' "$1" >>"$STATE/history.jsonl"; }

# The schema version of a database file (PRAGMA user_version): how many of the hub's migrations it has.
# Read with node:sqlite from an image, read-only, with no network; an absent database is 0.
schema_of() {
  local image=$1 db=${2:-/data/hub.db}
  podman run --rm --network none --user 1000:1000 -v "$HIVE_ROOT/data:/data:Z" -v "$HIVE_ROOT/backups:/data/backups:Z" \
    --entrypoint node "$image" -e '
      const fs = require("node:fs"); const f = process.argv[1];
      if (!fs.existsSync(f)) { console.log(0); process.exit(0); }
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(f, { readOnly: true });
      console.log(db.prepare("PRAGMA user_version").get().user_version);' "$db"
}

# integrity_check of a snapshot, from an image: "ok" or what is wrong.
integrity_of() {
  podman run --rm --network none --user 1000:1000 -v "$HIVE_ROOT/backups:/data/backups:Z" \
    --entrypoint node "$1" -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      console.log(db.prepare("PRAGMA integrity_check").get().integrity_check);' "$2"
}

# 0 when http://127.0.0.1:<port>/api/health answers {"result":{"ok":true}} within <seconds>.
wait_healthy() {
  local port=$1 seconds=$2 container=${3:-} end=$((SECONDS + $2))
  while [ $SECONDS -lt $end ]; do
    if [ -n "$container" ] && [ "$(podman inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
      log "$container is not running"
      return 1
    fi
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 3
  done
  log "no healthy answer on port $port within ${seconds}s"
  return 1
}

# The image line of the hub's unit as installed now (empty before the first deploy).
current_image() { sed -n 's/^Image=//p' "$QUADLET_DIR/hive-hub.container" 2>/dev/null | head -n 1; }

# Writes the hub's unit for <image@digest> and makes systemd read it.
write_hub_unit() {
  local image=$1 tmp
  tmp=$(mktemp)
  sed -e "s|@IMAGE@|$image|" -e "s|@PORT@|$HIVE_PORT|" "$SHARE_DIR/hive-hub.container.in" >"$tmp"
  install -m 0644 "$tmp" "$QUADLET_DIR/hive-hub.container"
  rm -f "$tmp"
  systemctl daemon-reload
}

# Keeps the newest <keep> deploy snapshots (the .db and the hub's .json next to it).
prune_deploy_backups() {
  local keep=$1
  ls -1t "$DEPLOY_BACKUPS"/hub-*.db 2>/dev/null | tail -n +"$((keep + 1))" | while read -r f; do
    rm -f "$f" "$f.json"
  done
}
