#!/usr/bin/env bash
set -Eeuo pipefail

# Reconcile IPv4-only Cloudflare ingress for HTTPS without touching unrelated
# UFW rules. Run as root or through sudo.
[[ $(id -u) -eq 0 ]] || exec sudo -- "$0" "$@"

readonly MARKER="cloudflare-https"
readonly URL="https://www.cloudflare.com/ips-v4"
mapfile -t ranges < <(curl --fail --proto '=https' --tlsv1.2 --silent --show-error "$URL" | awk 'NF && $1 !~ /^#/ {print $1}')
((${#ranges[@]} > 0)) || { echo "Cloudflare returned no IPv4 ranges" >&2; exit 1; }

# Remove only rules tagged by this script. UFW comments are preserved in the
# status output and make reconciliation independent of rule numbering.
while read -r rule; do
  [[ "$rule" == *"$MARKER"* ]] || continue
  ufw --force delete allow from "${rule%% *}" to any port 443 proto tcp comment "$MARKER" || true
done < <(ufw status | sed -n 's/^.*ALLOW IN[[:space:]]\+\([^[:space:]]\+\).*'"$MARKER"'.*$/\1/p')

for range in "${ranges[@]}"; do
  ufw allow from "$range" to any port 443 proto tcp comment "$MARKER" >/dev/null
done
ufw status numbered
