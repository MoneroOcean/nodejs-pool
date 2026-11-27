#!/bin/bash
set -euo pipefail

iface="${WATCHDOG_INTERFACE:?missing watchdog interface}"
read -r -a probes <<< "${WATCHDOG_PROBES:?missing watchdog probes}"
[[ "$iface" =~ ^[a-zA-Z0-9_-]+$ && -e "/sys/class/net/$iface/device/driver" ]]
[[ "${#probes[@]}" == 2 && "${probes[0]}" != "${probes[1]}" ]]
for probe in "${probes[@]}"; do
  [[ "$probe" =~ ^[0-9]+(\.[0-9]+){3}:[1-9][0-9]{0,4}$ ]]
  (( ${probe##*:} <= 65535 ))
done
[[ "${probes[0]%:*}" != "${probes[1]%:*}" ]]

tcp_reachable() {
  local host="${1%:*}" port="${1##*:}"
  timeout 2s bash -c 'true <> "/dev/tcp/$1/$2"' bash "$host" "$port" 2>/dev/null
}

network_works() {
  local probe
  for probe in "${probes[@]}"; do
    if ping -n -I "$iface" -c 1 -W 2 "${probe%:*}" >/dev/null 2>&1 || tcp_reachable "$probe"; then
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" = --check ]; then
  tcp_reachable "${probes[0]}" && tcp_reachable "${probes[1]}"
  exit
fi

state="${STATE_DIRECTORY:?run via the watchdog service}"
runtime="${RUNTIME_DIRECTORY:?run via the watchdog service}"
boot_id="$(cat /proc/sys/kernel/random/boot_id)"
read -r uptime _ < /proc/uptime
uptime="${uptime%.*}"

# Older kernels put the interface after NETDEV WATCHDOG. Newer ones prefix
# driver messages with the interface. Both e1000 and igb emit TX hang reports.
pattern="(^|[[:space:]])(${iface}: (Detected (Hardware |Tx )?Unit Hang|NETDEV WATCHDOG: .*transmit queue)|NETDEV WATCHDOG: ${iface} \\(.*\\): transmit queue)"
matches="$(journalctl -b -k --since '90 seconds ago' --grep "$pattern" -n 3 -o json --no-pager --quiet | wc -l)" || exit 0
if (( matches < 3 )) && [ ! -f "$runtime/reset" ]; then
  rm -f -- "$runtime/outage"
  exit 0
fi
if network_works; then
  rm -f -- "$runtime/outage" "$runtime/reset"
  exit 0
fi
[ ! -f "$runtime/reset" ] || exit 0

started="$uptime"
previous="$uptime"
if [ -f "$runtime/outage" ]; then
  read -r started previous < "$runtime/outage"
fi
if (( uptime - previous > 45 )); then
  started="$uptime"
fi
printf '%s %s\n' "$started" "$uptime" > "$runtime/outage"
(( uptime - started >= 600 )) || exit 0
touch "$runtime/reset"

echo "Repeated transmit hangs and failed connectivity probes on $iface. Resetting the interface"
timeout 5s ip link set dev "$iface" down || true
timeout 5s ip link set dev "$iface" up || true
for attempt in {1..5}; do
  sleep 3
  if network_works; then
    echo "Network recovered after interface reset"
    rm -- "$runtime/outage" "$runtime/reset"
    exit 0
  fi
done

now="$(date +%s)"
last_restart=0
last_boot=
if [ -f "$state/last-restart" ]; then
  read -r last_restart last_boot < "$state/last-restart"
fi
if [[ "$last_boot" = "$boot_id" ]] || (( now - last_restart < 21600 )); then
  echo "Network is still down. Automatic restart suppressed by the restart cooldown"
  exit 0
fi

printf '%s %s\n' "$now" "$boot_id" > "$state/.last-restart"
mv -- "$state/.last-restart" "$state/last-restart"
sync -f "$state"
echo "Requesting a graceful reboot after network recovery failed"
systemctl reboot
