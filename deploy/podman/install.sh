#!/usr/bin/env bash
# Installs the hub's Podman deployment on the Linux VM (as root, from a copy of deploy/podman):
#   sudo bash install.sh
# Idempotent: run it again after pulling a newer deploy/podman; existing settings and data are left alone.
# Then: fill /etc/xdev-hive/hub.env, `podman login ghcr.io` if the package is private, and `hive-deploy`.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

for cmd in podman skopeo curl flock systemctl; do
  command -v "$cmd" >/dev/null || { echo "missing $cmd: dnf install -y podman skopeo curl util-linux" >&2; exit 1; }
done
# Quadlet's Notify=healthy needs Podman 5.
major=$(podman version --format '{{.Client.Version}}' | cut -d. -f1)
[ "$major" -ge 5 ] || { echo "Podman 5 or newer needed (found $(podman version --format '{{.Client.Version}}'))" >&2; exit 1; }

# Data. The hub runs as uid 1000 (node) in its image; SeaweedFS as root in its own.
install -d -m 0750 -o 1000 -g 1000 /srv/hive/data /srv/hive/backups /srv/hive/backups/deploy
install -d -m 0750 /srv/hive/seaweedfs /srv/hive/state /srv/hive/logs
# Settings: examples only where nothing is there yet.
install -d -m 0700 /etc/xdev-hive
[ -f /etc/xdev-hive/hub.env ] || install -m 0600 "$here/hub.env.example" /etc/xdev-hive/hub.env
[ -f /etc/xdev-hive/deploy.env ] || install -m 0600 "$here/deploy.env.example" /etc/xdev-hive/deploy.env

# Scripts and units.
install -d /usr/local/lib/xdev-hive /usr/local/share/xdev-hive /etc/containers/systemd
install -m 0644 "$here/lib.sh" /usr/local/lib/xdev-hive/lib.sh
install -m 0755 "$here/hive-deploy.sh" /usr/local/bin/hive-deploy
install -m 0755 "$here/hive-rollback.sh" /usr/local/bin/hive-rollback
install -m 0755 "$here/hive-status.sh" /usr/local/bin/hive-status
install -m 0644 "$here/quadlet/hive-hub.container.in" /usr/local/share/xdev-hive/hive-hub.container.in
install -m 0644 "$here/quadlet/hive.network" "$here/quadlet/hive-seaweedfs.container" /etc/containers/systemd/
install -m 0644 "$here/systemd/hive-deploy.service" "$here/systemd/hive-deploy.timer" /etc/systemd/system/

# Logs kept across reboots, and bounded.
install -d /var/log/journal /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=2G\n' >/etc/systemd/journald.conf.d/xdev-hive.conf
systemctl restart systemd-journald

# The hub's port, open in the VM (the Windows host decides who reaches the VM).
if systemctl is-active -q firewalld; then
  port=$(sed -n 's/^HIVE_PORT=//p' /etc/xdev-hive/deploy.env | tail -n 1)
  firewall-cmd -q --permanent --add-port="${port:-7788}/tcp" && firewall-cmd -q --reload
fi

systemctl daemon-reload
systemctl start hive-network.service hive-seaweedfs.service
# Enabled for boot, not started: the first deploy waits until hub.env holds the real settings.
systemctl enable hive-deploy.timer
echo "installed. Next: edit /etc/xdev-hive/hub.env, run hive-deploy, then systemctl start hive-deploy.timer."
