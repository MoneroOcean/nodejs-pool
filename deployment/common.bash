#!/bin/bash

# Source-only helpers shared by the deploy and leaf installers.
# Keep this file free of top-level work: both entrypoints load it before their
# own validation and installation steps.
MONEROOCEAN_COMMON_API_VERSION=1

is_test_mode() {
  [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]
}

retry_command() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi
    [ "$attempt" -eq 5 ] || sleep $((attempt * 5))
  done
  return 1
}

install_node_dependencies() {
  if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
    retry_command npm ci "$@"
  else
    retry_command npm install "$@"
  fi
}

configure_user_npm_min_release_age() {
  local npm_user_config="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
  npm config set min-release-age 7 --location=user
  chmod 600 "$npm_user_config"
}

configure_journald_retention() {
  install -d -m 755 /etc/systemd/journald.conf.d
  cat >/etc/systemd/journald.conf.d/90-moneroocean-retention.conf <<'EOF'
[Journal]
SystemMaxUse=100M
SystemKeepFree=1G
SystemMaxFileSize=10M
EOF
}

configure_needrestart_pm2_guard() {
  install -d -m 755 /etc/needrestart/conf.d
  rm -f /etc/needrestart/conf.d/moneroocean-critical.conf
  cat >/etc/needrestart/conf.d/moneroocean-pm2.conf <<'EOF'
# Keep unattended package maintenance from restarting the pool process manager.
# Restart PM2 deliberately during a maintenance window to load updated libraries.
$nrconf{override_rc}->{qr(^pm2-user\.service$)} = 0;
EOF
}

clone_repo_once() {
  local repo="$1"
  local dest="$2"
  if [ -d "$dest/.git" ]; then
    return 0
  fi
  retry_command git clone "$repo" "$dest"
}

configure_overcommit() {
  install -d -m 755 /etc/sysctl.d
  cat >/etc/sysctl.d/90-monero-overcommit.conf <<'EOF'
vm.overcommit_memory = 2
vm.overcommit_ratio = 150
EOF
  if ! sysctl -p /etc/sysctl.d/90-monero-overcommit.conf; then
    if is_test_mode; then
      echo "Skipping active overcommit sysctl apply in test mode"
      return 0
    fi
    return 1
  fi
}

configure_pool_conntrack() {
  install -d -m 755 /etc/modules-load.d /etc/sysctl.d
  printf 'nf_conntrack\n' >/etc/modules-load.d/moneroocean-conntrack.conf
  cat >/etc/sysctl.d/92-moneroocean-conntrack.conf <<EOF
# Leave headroom for daemon RPC and management traffic during miner reconnect bursts.
net.netfilter.nf_conntrack_max = $POOL_CONNTRACK_MAX
EOF
  if is_test_mode; then
    echo "Skipping active conntrack module load and sysctl apply in test mode"
    return 0
  fi
  modprobe nf_conntrack
  sysctl -p /etc/sysctl.d/92-moneroocean-conntrack.conf
  if [ "$(sysctl -n net.netfilter.nf_conntrack_max)" != "$POOL_CONNTRACK_MAX" ]; then
    echo "nf_conntrack_max did not apply: expected $POOL_CONNTRACK_MAX, got $(sysctl -n net.netfilter.nf_conntrack_max)" >&2
    return 1
  fi
}

configure_pool_health_guard() {
  local guard_dir=/usr/local/libexec/moneroocean
  install -d -o root -g root -m 755 "$guard_dir"
  install -o root -g root -m 755 /home/user/nodejs-pool/pool_health_guard.sh "$guard_dir/pool-health-guard"
  install -o root -g root -m 644 /home/user/nodejs-pool/deployment/pool-health-guard.service /lib/systemd/system/pool-health-guard.service
  install -o root -g root -m 644 /home/user/nodejs-pool/deployment/pool-health-guard.timer /lib/systemd/system/pool-health-guard.timer
  systemctl daemon-reload
  systemctl enable pool-health-guard.timer
  if ! is_test_mode; then
    systemctl restart pool-health-guard.timer
  fi
}

configure_swap() {
  if awk 'NR > 1 {found = 1} END {exit found ? 0 : 1}' /proc/swaps; then
    return 0
  fi
  if grep -Eq '^[^#]+[[:space:]]+[^[:space:]]+[[:space:]]+swap[[:space:]]' /etc/fstab; then
    swapon -a
    return 0
  fi
  if [ ! -f /swapfile ] || [ "$(stat -c %s /swapfile 2>/dev/null || echo 0)" -lt 1073741824 ]; then
    rm -f /swapfile
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  fi
  chmod 600 /swapfile
  if ! awk 'NR > 1 && $1 == "/swapfile" {found = 1} END {exit found ? 0 : 1}' /proc/swaps; then
    mkswap -f /swapfile
    chmod 600 /swapfile
    if [ "$(awk 'NR > 1 {total += $3} END {print total + 0}' /proc/swaps)" -eq 0 ]; then
      if ! swapon /swapfile; then
        if is_test_mode; then
          echo "Skipping active swap enable in test mode"
        else
          return 1
        fi
      fi
    fi
  fi
  if ! grep -Eq '^[^#]*[[:space:]]/swapfile[[:space:]]' /etc/fstab; then
    echo " /swapfile none swap sw 0 0" >>/etc/fstab
  fi
}

default_tari_memory_high() {
  local mem_kb
  mem_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo)"
  if [ "$mem_kb" -ge $((30 * 1024 * 1024)) ]; then
    echo 18G
  else
    echo 12G
  fi
}

validate_systemd_memory_limit() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^(infinity|max|[0-9]+([.][0-9]+)?[KMGTPE]?)$ ]]; then
    echo "Invalid $name value: $value" >&2
    exit 1
  fi
}

rpc_synced() {
  local url="$1"
  local method="$2"
  local response
  response="$(curl -fsS -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":\"0\",\"method\":\"$method\",\"params\":{}}" "$url")" || return 1
  printf '%s' "$response" | python3 -c '
import json
import sys

method = sys.argv[1]
payload = json.load(sys.stdin)
result = payload.get("result") or {}
if method == "get_info":
    sys.exit(0 if result.get("status") == "OK" and result.get("synchronized") is True and result.get("busy_syncing") is not True else 1)
if method == "GetTipInfo":
    metadata = result.get("metadata") or {}
    synced = result.get("initial_sync_achieved")
    height = int(metadata.get("best_block_height") or 0)
    sys.exit(0 if synced is True and height > 0 else 1)
sys.exit(1)
' "$method"
}

ensure_rust_toolchain() {
  if [ -s "$HOME/.cargo/env" ]; then
    . "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    retry_command bash -lc 'set -o pipefail; curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable'
    . "$HOME/.cargo/env"
  fi
  retry_command rustup update stable
}

checkout_repo_ref() {
  local repo="$1"
  local dest="$2"
  local ref="$3"
  if [ -e "$dest" ] && [ ! -d "$dest/.git" ]; then
    mv "$dest" "$dest.pre-source.$(date +%Y%m%d%H%M%S)"
  fi
  clone_repo_once "$repo" "$dest"
  cd "$dest"
  retry_command git fetch --tags origin
  git checkout --force "$ref"
}

ensure_tari_user() {
  id -u "$TARI_USER" >/dev/null 2>&1 || useradd -m -d "$TARI_HOME" -s /bin/sh "$TARI_USER"
  install -d -m 755 -o "$TARI_USER" -g "$TARI_USER" "$TARI_HOME"
}

configure_monero_hugepages() {
  local gid
  groupadd --system "$HUGEPAGES_GROUP" 2>/dev/null || true
  usermod -a -G "$HUGEPAGES_GROUP" monerodaemon
  gid="$(getent group "$HUGEPAGES_GROUP" | cut -d: -f3)"
  test -n "$gid"
  install -d -m 755 /etc/sysctl.d
  cat >/etc/sysctl.d/91-moneroocean-hugepages.conf <<EOF
vm.nr_hugepages = $MONERO_RANDOMX_HUGEPAGES
vm.hugetlb_shm_group = $gid
EOF
  echo 1 >/proc/sys/vm/compact_memory 2>/dev/null || true
  if ! sysctl -p /etc/sysctl.d/91-moneroocean-hugepages.conf; then
    if is_test_mode; then
      echo "Skipping active hugepage sysctl apply in test mode"
      return 0
    fi
    return 1
  fi
  if [ "$(sysctl -n vm.nr_hugepages)" -lt "$MONERO_RANDOMX_HUGEPAGES" ]; then
    echo "Warning: requested $MONERO_RANDOMX_HUGEPAGES hugepages but only $(sysctl -n vm.nr_hugepages) are available until reboot or more memory compaction"
  fi
}

write_monero_service() {
  local block_notify_arg=""
  if [ "${1:-}" = "enable-block-notify" ]; then
    block_notify_arg=" --block-notify '/bin/bash /home/user/nodejs-pool/block_notify.sh'"
  fi
  cat >/lib/systemd/system/monero.service <<EOF
[Unit]
Description=Monero Daemon
After=network.target

[Service]
Environment=MALLOC_ARENA_MAX=2
SupplementaryGroups=$HUGEPAGES_GROUP
LimitMEMLOCK=infinity
ExecStart=/usr/local/src/monero/build/release/bin/monerod --rpc-bind-ip=127.0.0.1 --rpc-bind-port=18083 --hide-my-port --prune-blockchain --enable-dns-blocklist --no-zmq --out-peers 64 --non-interactive --log-level '$MONERO_LOG_CATEGORIES'$block_notify_arg
Restart=always
User=monerodaemon
Nice=10
CPUQuota=400%

[Install]
WantedBy=multi-user.target
EOF
}

write_tari_service() {
  cat >/lib/systemd/system/xtm.service <<EOF
[Unit]
Description=Tari Daemon
After=network.target

[Service]
# Tari SubmitBlock JSON bodies can exceed grpc-json-proxy's 1 MiB default when
# the block carries a large proof body.
ExecStart=/bin/bash -c "(sleep 2; /usr/bin/node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18146 18142 --max-body-bytes 16777216) & (sleep 2; /usr/bin/node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18148 18142 --max-body-bytes 16777216) & /usr/local/src/tari/target/release/minotari_node --non-interactive-mode --watch status --disable-splash-screen"
Restart=always
User=$TARI_USER
Environment=HOME=$TARI_HOME
Nice=10
CPUQuota=400%
MemoryHigh=$TARI_MEMORY_HIGH
MemorySwapMax=$TARI_MEMORY_SWAP_MAX

[Install]
WantedBy=multi-user.target
EOF
}

write_tari_merge_mining_service() {
  local dependencies="$1"
  cat >/lib/systemd/system/xtm_mm.service <<EOF
[Unit]
Description=Tari Merge Mining Daemon
After=network.target $dependencies
PartOf=$dependencies

[Service]
ExecStart=/usr/local/src/tari/target/release/minotari_merge_mining_proxy --non-interactive-mode
Restart=always
RestartSec=3s
StartLimitBurst=0
User=$TARI_USER
Environment=HOME=$TARI_HOME
Nice=10
CPUQuota=400%
MemoryHigh=$TARI_MM_MEMORY_HIGH
MemorySwapMax=$TARI_MM_MEMORY_SWAP_MAX

[Install]
WantedBy=multi-user.target
EOF
}
