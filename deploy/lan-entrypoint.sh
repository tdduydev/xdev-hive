#!/bin/sh
# Entry of the LAN Caddy (compose.lan.yaml): HIVE_LAN_HOSTS (a, b, 192.0.2.52) → the site addresses of Caddyfile.lan,
# one https://<host>:7743 each, and the first one as the name to answer when a client sends none. Then the root
# certificate's SHA-256 beside the certificate, once Caddy has made it, for /ca.sha256.
# Sourced by the test (LAN_ENTRY_NO_EXEC=1) to check the conversion without Caddy.
lan_sites() {
  # $1 hosts (comma or space separated), $2 port inside the container
  printf '%s' "$1" | tr ', ' '\n\n' | sed '/^$/d' | sed "s|^|https://|; s|\$|:$2|" | paste -sd, - | sed 's/,/, /g'
}
lan_first_host() { printf '%s' "$1" | tr ', ' '\n\n' | sed '/^$/d' | head -n 1; }

[ -n "${LAN_ENTRY_NO_EXEC:-}" ] && return 0 2>/dev/null || true
: "${HIVE_LAN_HOSTS:?set HIVE_LAN_HOSTS}"
HIVE_LAN_SITES=$(lan_sites "$HIVE_LAN_HOSTS" 7743)
HIVE_LAN_DEFAULT_SNI=$(lan_first_host "$HIVE_LAN_HOSTS")
export HIVE_LAN_SITES HIVE_LAN_DEFAULT_SNI
root=/data/caddy/pki/authorities/local
(
  for _ in $(seq 1 60); do
    if [ -s "$root/root.crt" ]; then
      # No openssl in the image: the DER bytes are the PEM body decoded.
      grep -v -- '-----' "$root/root.crt" | base64 -d | sha256sum | cut -d' ' -f1 >"$root/root.sha256" 2>/dev/null || true
      break
    fi
    sleep 1
  done
) &
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
