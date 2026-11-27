#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run the watchdog installer as root" >&2
  exit 1
fi

deployment_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
iface="${1:?missing network interface}"
probes="${2:?missing probe endpoints}"
settings_dir=/etc/moneroocean

[[ "$iface" =~ ^[a-zA-Z0-9_-]+$ ]]
[[ "$probes" =~ ^[0-9.:[:blank:]]+$ ]]
if ! WATCHDOG_INTERFACE="$iface" WATCHDOG_PROBES="$probes" \
    bash "$deployment_dir/leaf-network-watchdog.bash" --check; then
  echo "The watchdog interface and both probe endpoints must be reachable during setup" >&2
  exit 1
fi

guard_dir=/usr/local/libexec/moneroocean
unit_dir=/etc/systemd/system
temp="$(mktemp -d)"
trap 'rm -f -- "$temp/config"; rmdir -- "$temp"' EXIT

printf 'WATCHDOG_INTERFACE=%s\nWATCHDOG_PROBES="%s"\n' "$iface" "$probes" > "$temp/config"

install -d -m 755 "$settings_dir" "$guard_dir"
install -m 600 "$temp/config" "$settings_dir/leaf-network-watchdog.conf"
install -m 755 "$deployment_dir/leaf-network-watchdog.bash" "$guard_dir/leaf-network-watchdog"
install -m 644 "$deployment_dir/leaf-network-watchdog.service" "$deployment_dir/leaf-network-watchdog.timer" "$unit_dir"
systemctl daemon-reload
systemctl enable --now leaf-network-watchdog.timer
