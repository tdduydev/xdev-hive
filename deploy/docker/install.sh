#!/usr/bin/env bash
# Sets up the automatic hub deploy for the current user on a Docker Compose host (no root needed; the user must be in
# the docker group). Run from the checkout the hub's compose project lives in:
#   bash deploy/docker/install.sh
# Copies the scripts out of the repo (the deploy checks the repo out at each image's commit, so they must not run from
# it), writes ~/.config/xdev-hive/deploy.env if missing, and adds a crontab line running hive-deploy every two minutes.
# Docker's restart policy (unless-stopped) brings the hub back after a reboot, pinned to the last deployed digest.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
for cmd in docker curl flock git crontab; do command -v "$cmd" >/dev/null || { echo "missing $cmd" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { echo "this user cannot reach Docker (add it to the docker group, then log in again)" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx is needed to read the prod tag (docker-buildx-plugin)" >&2; exit 1; }

install -d "$HOME/.local/bin" "$HOME/.local/lib/xdev-hive" "$HOME/.config/xdev-hive" "$HOME/.local/state/xdev-hive/logs"
install -m 0644 "$here/lib.sh" "$HOME/.local/lib/xdev-hive/lib.sh"
for s in hive-deploy hive-rollback hive-status; do install -m 0755 "$here/$s.sh" "$HOME/.local/bin/$s"; done
if [ ! -f "$HOME/.config/xdev-hive/deploy.env" ]; then
  umask 077
  sed "s#^HIVE_REPO=.*#HIVE_REPO=$repo#" "$here/deploy.env.example" >"$HOME/.config/xdev-hive/deploy.env"
fi

line="*/2 * * * * $HOME/.local/bin/hive-deploy >/dev/null 2>&1"
if [ "${HIVE_NO_CRON:-}" != 1 ]; then
  { crontab -l 2>/dev/null | grep -v 'hive-deploy' || true; echo "$line"; } | crontab -
  echo "cron: hive-deploy every two minutes"
fi
echo "installed for $(whoami). Check ~/.config/xdev-hive/deploy.env, then: hive-deploy && hive-status"
