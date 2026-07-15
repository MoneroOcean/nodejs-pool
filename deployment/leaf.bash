#!/bin/bash
set -Eeuo pipefail
trap 'echo "Leaf deployment failed at line $LINENO: $BASH_COMMAND" >&2' ERR

NODEJS_VERSION="${NODEJS_VERSION:-v24.15.0}"
MONERO_REPO_URL="${MONERO_REPO_URL:-https://github.com/monero-project/monero.git}"
MONERO_RELEASE_TAG="${MONERO_RELEASE_TAG:-v0.18.5.1}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.4.1}"
TARI_REPO_URL="${TARI_REPO_URL:-https://github.com/tari-project/tari.git}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"
TARI_INSTALL_DIR="${TARI_INSTALL_DIR:-/usr/local/src/tari}"
TARI_USER="${TARI_USER:-taridaemon}"
TARI_HOME="${TARI_HOME:-/home/$TARI_USER}"
TARI_CONFIG_PATCH_URL="${TARI_CONFIG_PATCH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh}"
TARI_EXTERNAL_IP="${TARI_EXTERNAL_IP:-}"
TARI_WALLET_PAYMENT_ADDRESS="${TARI_WALLET_PAYMENT_ADDRESS:-}"
TARI_PRUNING_HORIZON="${TARI_PRUNING_HORIZON:-10000}"
TARI_PRUNING_INTERVAL="${TARI_PRUNING_INTERVAL:-50}"
SSH_FAIL2BAN_IGNORE_IPS="${SSH_FAIL2BAN_IGNORE_IPS:-}"
MONERO_SYNC_TIMEOUT_SECONDS="${MONERO_SYNC_TIMEOUT_SECONDS:-172800}"
TARI_SYNC_TIMEOUT_SECONDS="${TARI_SYNC_TIMEOUT_SECONDS:-172800}"
SYNC_POLL_INTERVAL_SECONDS="${SYNC_POLL_INTERVAL_SECONDS:-10}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this script as root"
  exit 1
fi

# Transient systemd units do not necessarily inherit a login HOME.
export HOME="${HOME:-/root}"
export DEBIAN_FRONTEND=noninteractive
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

configure_journald_retention() {
  install -d -m 755 /etc/systemd/journald.conf.d
  cat >/etc/systemd/journald.conf.d/90-moneroocean-retention.conf <<'EOF'
[Journal]
SystemMaxUse=100M
SystemKeepFree=1G
SystemMaxFileSize=10M
EOF
}

configure_ssh_hardening() {
  # This node is administered with SSH keys only; keep the public SSH port
  # available so loss of a single management IP cannot lock out the server.
  install -d -m 755 /etc/ssh/sshd_config.d
  cat >/etc/ssh/sshd_config.d/00-moneroocean-hardening.conf <<'EOF'
# Processed before cloud-init snippets; OpenSSH uses the first value it sees.
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
EOF
  passwd -l root >/dev/null
  passwd -l user >/dev/null
  if command -v sshd >/dev/null 2>&1; then
    sshd -t
    if systemctl is-active --quiet ssh.service; then
      systemctl reload ssh.service
    else
      service ssh reload
    fi
  fi
}

fail2ban_ignore_ips() {
  local raw="$SSH_FAIL2BAN_IGNORE_IPS"
  local ssh_source=""
  local candidate
  local result="127.0.0.1/8 ::1"
  if [ -n "${SSH_CONNECTION:-}" ]; then
    ssh_source="${SSH_CONNECTION%% *}"
    raw="$raw $ssh_source"
  fi
  for candidate in $raw; do
    python3 - "$candidate" <<'PY'
import ipaddress
import sys

value = sys.argv[1]
try:
    ipaddress.ip_network(value, strict=False)
except ValueError as exc:
    raise SystemExit(f"invalid SSH_FAIL2BAN_IGNORE_IPS entry {value!r}: {exc}")
PY
    case " $result " in
      *" $candidate "*) ;;
      *) result="$result $candidate" ;;
    esac
  done
  printf '%s\n' "$result"
}

configure_ssh_fail2ban() {
  local ignore_ips
  ignore_ips="$(fail2ban_ignore_ips)"
  install -d -m 755 /etc/fail2ban/jail.d
  cat >/etc/fail2ban/jail.d/moneroocean-sshd.local <<EOF
[sshd]
enabled = true
backend = systemd
port = ssh
maxretry = 5
findtime = 10m
bantime = 1h
# Trusted management addresses bypass bans; this does not restrict who may SSH.
ignoreip = $ignore_ips
EOF
  fail2ban-client -t
  if is_test_mode; then
    echo "Skipping active Fail2ban startup in test mode"
    return 0
  fi
  systemctl enable fail2ban.service
  systemctl restart fail2ban.service
  for _ in $(seq 1 30); do
    if fail2ban-client ping >/dev/null 2>&1; then
      fail2ban-client status sshd
      return 0
    fi
    sleep 1
  done
  echo "Fail2ban did not become ready" >&2
  return 1
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

TARI_MEMORY_HIGH="${TARI_MEMORY_HIGH:-$(default_tari_memory_high)}"
TARI_MEMORY_SWAP_MAX="${TARI_MEMORY_SWAP_MAX:-768M}"
TARI_MM_MEMORY_HIGH="${TARI_MM_MEMORY_HIGH:-1200M}"
TARI_MM_MEMORY_SWAP_MAX="${TARI_MM_MEMORY_SWAP_MAX:-384M}"
validate_systemd_memory_limit() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^(infinity|max|[0-9]+([.][0-9]+)?[KMGTPE]?)$ ]]; then
    echo "Invalid $name value: $value" >&2
    exit 1
  fi
}

validate_systemd_memory_limit "$TARI_MEMORY_HIGH" TARI_MEMORY_HIGH
validate_systemd_memory_limit "$TARI_MEMORY_SWAP_MAX" TARI_MEMORY_SWAP_MAX
validate_systemd_memory_limit "$TARI_MM_MEMORY_HIGH" TARI_MM_MEMORY_HIGH
validate_systemd_memory_limit "$TARI_MM_MEMORY_SWAP_MAX" TARI_MM_MEMORY_SWAP_MAX
validate_non_negative_integer() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "Invalid $name value: $value" >&2
    exit 1
  fi
}
validate_positive_integer() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid $name value: $value" >&2
    exit 1
  fi
}
validate_non_negative_integer "$TARI_PRUNING_HORIZON" TARI_PRUNING_HORIZON
validate_positive_integer "$TARI_PRUNING_INTERVAL" TARI_PRUNING_INTERVAL
validate_non_negative_integer "$MONERO_SYNC_TIMEOUT_SECONDS" MONERO_SYNC_TIMEOUT_SECONDS
validate_non_negative_integer "$TARI_SYNC_TIMEOUT_SECONDS" TARI_SYNC_TIMEOUT_SECONDS
validate_positive_integer "$SYNC_POLL_INTERVAL_SECONDS" SYNC_POLL_INTERVAL_SECONDS
HUGEPAGES_GROUP="${HUGEPAGES_GROUP:-hugepages}"
MONERO_RANDOMX_HUGEPAGES="${MONERO_RANDOMX_HUGEPAGES:-384}"
MONERO_LOG_CATEGORIES="${MONERO_LOG_CATEGORIES:-*:ERROR,global:INFO,sync-info:INFO,cn:ERROR,blockchain:ERROR,verify:ERROR}"

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

rpc_sync_progress() {
  local label="$1"
  local url="$2"
  local method="$3"
  local response
  response="$(curl -fsS -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":\"0\",\"method\":\"$method\",\"params\":{}}" "$url")" || {
    echo "$label sync progress: RPC not ready"
    return 0
  }
  printf '%s' "$response" | python3 -c '
import json
import sys

label, method = sys.argv[1:]
payload = json.load(sys.stdin)
result = payload.get("result") or {}
if method == "get_info":
    height = int(result.get("height") or 0)
    target = int(result.get("target_height") or 0)
    synchronized = result.get("synchronized")
    busy = result.get("busy_syncing")
    print(f"{label} sync progress: height={height} target={target} synchronized={synchronized} busy={busy}")
elif method == "GetTipInfo":
    metadata = result.get("metadata") or {}
    height = int(metadata.get("best_block_height") or 0)
    synced = result.get("initial_sync_achieved")
    print(f"{label} sync progress: height={height} initial_sync_achieved={synced}")
' "$label" "$method" || echo "$label sync progress: malformed RPC response"
}

wait_for_rpc_sync() {
  local label="$1"
  local url="$2"
  local method="$3"
  local timeout_seconds="$4"
  local started_at now elapsed last_report=0
  started_at="$(date +%s)"
  echo "Please wait until $label daemon is fully synced"
  while true; do
    if rpc_synced "$url" "$method"; then
      echo "$label daemon is synced"
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started_at))
    if [ "$last_report" -eq 0 ] || [ $((now - last_report)) -ge 60 ]; then
      rpc_sync_progress "$label" "$url" "$method"
      df -h / | awk 'NR == 2 { print "root filesystem: used=" $3 " available=" $4 " capacity=" $5 }'
      last_report="$now"
    fi
    if [ "$timeout_seconds" -gt 0 ] && [ "$elapsed" -ge "$timeout_seconds" ]; then
      echo "Timed out after ${timeout_seconds}s waiting for $label daemon sync" >&2
      return 1
    fi
    sleep "$SYNC_POLL_INTERVAL_SECONDS"
  done
}

wait_for_monero_sync() {
  wait_for_rpc_sync Monero http://127.0.0.1:18083/json_rpc get_info "$MONERO_SYNC_TIMEOUT_SECONDS"
}

wait_for_tari_sync() {
  wait_for_rpc_sync Tari http://127.0.0.1:18146/json_rpc GetTipInfo "$TARI_SYNC_TIMEOUT_SECONDS"
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

install_tari_suite() {
  ensure_rust_toolchain
  checkout_repo_ref "$TARI_REPO_URL" "$TARI_INSTALL_DIR" "$TARI_RELEASE_TAG"
  # Cargo.lock belongs to the selected release and prevents an accidental
  # dependency upgrade from changing a production build.
  TARI_TARGET_NETWORK="$TARI_NETWORK" cargo build --release --locked -p minotari_node -p minotari_merge_mining_proxy
  if [ ! -f "$TARI_HOME/.tari/mainnet/config/config.toml" ]; then
    sudo -u "$TARI_USER" env HOME="$TARI_HOME" "$TARI_INSTALL_DIR/target/release/minotari_node" --init --network mainnet --non-interactive-mode --disable-splash-screen
  fi
}
patch_tari_config() {
  local patcher="/usr/local/src/patch-tari-config.sh"
  local bundled_patcher="$SCRIPT_DIR/patch-tari-config.sh"
  local config="$TARI_HOME/.tari/mainnet/config/config.toml"
  local args=("$config" "--no-backup" "--pruning-horizon" "$TARI_PRUNING_HORIZON" "--pruning-interval" "$TARI_PRUNING_INTERVAL")
  # Deployments copy both scripts together. Prefer that reviewed copy and use
  # the URL only for the documented curl-pipe installation path.
  if [ -f "$bundled_patcher" ]; then
    install -m 755 "$bundled_patcher" "$patcher"
  else
    retry_command curl -fsSL -o "$patcher" "$TARI_CONFIG_PATCH_URL"
    chmod 755 "$patcher"
  fi
  if [ -n "$TARI_EXTERNAL_IP" ]; then
    args+=("--base-node-grpc-ip" "$TARI_EXTERNAL_IP")
  fi
  if [ -z "$TARI_WALLET_PAYMENT_ADDRESS" ]; then
    echo "TARI_WALLET_PAYMENT_ADDRESS must be set to your Tari wallet payment address" >&2
    return 1
  fi
  args+=("--wallet-payment-address" "$TARI_WALLET_PAYMENT_ADDRESS")
  "$patcher" "${args[@]}"
  chown "$TARI_USER:$TARI_USER" "$config"
}

build_monero_release() {
  # A leaf runs monerod only. Building the daemon target avoids compiling the
  # wallet CLI/RPC and blockchain maintenance tools that `make release` adds.
  cmake -S . -B build/release -D CMAKE_BUILD_TYPE=Release
  cmake --build build/release --target daemon --parallel "$(nproc)" ||
    cmake --build build/release --target daemon --parallel 1
  git rev-parse HEAD >build/release/.moneroocean-build-commit
}

monero_build_is_current() {
  # A binary can survive a source-tag change. The commit stamp makes reruns
  # rebuild exactly when the checked-out Monero release has changed.
  if is_test_mode; then
    [ -x /usr/local/src/monero/build/release/bin/monerod ]
    return
  fi
  [ -x /usr/local/src/monero/build/release/bin/monerod ] &&
    [ -r build/release/.moneroocean-build-commit ] &&
    [ "$(cat build/release/.moneroocean-build-commit)" = "$(git rev-parse HEAD)" ]
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

configure_overcommit
configure_swap
configure_journald_retention

retry_command apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
if is_test_mode; then
  echo "Skipping apt full-upgrade in test mode"
else
  retry_command apt-get -o Acquire::Retries=3 full-upgrade -y
fi
packages=(
  acl ca-certificates curl wget openssl sudo ufw fail2ban git vim unzip python3
  g++ make libc6-dev cmake pkg-config autoconf automake libtool clang
  libssl-dev libsqlite3-dev sqlite3 libc++-dev libc++abi-dev
  libprotobuf-dev protobuf-compiler libncurses-dev libunbound-dev
  libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev
  libzmq3-dev libcap2-bin
)
retry_command apt-get -o Acquire::Retries=3 install -y "${packages[@]}"
timedatectl set-timezone Etc/UTC

id -u user >/dev/null 2>&1 || adduser --disabled-password --gecos "" user
grep -q "user ALL=(ALL) NOPASSWD:ALL" /etc/sudoers || echo "user ALL=(ALL) NOPASSWD:ALL" >>/etc/sudoers
install -d -m 700 -o user -g user /home/user/.ssh
if [ -f "/root/.ssh/authorized_keys" ]; then
  mv /root/.ssh/authorized_keys /home/user/.ssh/authorized_keys
  chown user:user /home/user/.ssh/authorized_keys
  chmod 600 /home/user/.ssh/authorized_keys
fi
# Validate and reload SSH only after the key has safely moved to the new user.
configure_ssh_hardening

ufw default deny incoming
ufw default allow outgoing
for rule in ssh 3333 5555 7777 18141 18189; do
  ufw allow "$rule"
done
ufw --force enable
configure_ssh_fail2ban

printf 'colorscheme desert\nset fo-=ro\n' >/root/.vimrc
install -m 644 -o user -g user /root/.vimrc /home/user/.vimrc
checkout_repo_ref "$MONERO_REPO_URL" /usr/local/src/monero "$MONERO_RELEASE_TAG"
retry_command git submodule update --init
if ! monero_build_is_current; then
  rm -rf build
  build_monero_release
fi

id -u monerodaemon >/dev/null 2>&1 || useradd -m monerodaemon -d /home/monerodaemon
ensure_tari_user
configure_monero_hugepages

# Initial sync can import millions of historical blocks. Do not fork one
# block-notify shell per historical block; enable notifications at the end.
write_monero_service

install_tari_suite
if [ -z "$TARI_EXTERNAL_IP" ]; then
  clone_repo_once https://github.com/MoneroOcean/grpc-json-proxy.git /usr/local/src/grpc-json-proxy
fi
patch_tari_config

if [ -z "$TARI_EXTERNAL_IP" ]; then
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
fi

xtm_mm_dependency_units="monero.service"
if [ -z "$TARI_EXTERNAL_IP" ]; then
  xtm_mm_dependency_units="$xtm_mm_dependency_units xtm.service"
fi

cat >/lib/systemd/system/xtm_mm.service <<EOF
[Unit]
Description=Tari Merge Mining Daemon
After=network.target $xtm_mm_dependency_units
PartOf=$xtm_mm_dependency_units

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

systemctl daemon-reload
if [ -z "$TARI_EXTERNAL_IP" ]; then
  systemctl enable monero xtm xtm_mm
else
  systemctl enable monero xtm_mm
fi
systemctl start monero

# Monero synchronization is independent of Node dependency installation, so
# overlap those two long stages. Tari starts below because its gRPC bridges use
# the Node modules installed here.
su -l user -s /bin/bash <<EOF
set -ex
$(declare -f retry_command)
$(declare -f install_node_dependencies)
if [ ! -f /home/user/.nvm/nvm.sh ]; then
  retry_command bash -lc 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash'
fi
source /home/user/.nvm/nvm.sh
retry_command nvm install $NODEJS_VERSION
NODEJS_VERSION="\$(nvm version "$NODEJS_VERSION")"
nvm alias default "\$NODEJS_VERSION"
NODE_BINARY="\$(command -v node)"
# Service accounts cannot rely on traversing the administrator's private NVM
# directory. Install a real system binary and keep the NVM copy for pool PM2.
sudo install -m 755 "\$NODE_BINARY" /usr/local/bin/node
sudo ln -sfn /usr/local/bin/node /usr/bin/node
test -x /usr/bin/npm || sudo ln -s "\$(command -v npm)" /usr/bin/npm
sudo setcap cap_net_bind_service=+ep "\$NODE_BINARY"
sudo setcap cap_net_bind_service=+ep /usr/local/bin/node
if [ -d /usr/local/src/grpc-json-proxy ]; then
  sudo chown -R user:user /usr/local/src/grpc-json-proxy
  cd /usr/local/src/grpc-json-proxy
  if [ ! -d node_modules ]; then
    retry_command npm install --omit=dev --min-release-age=7
  fi
fi
cd /home/user
if [ ! -d /home/user/nodejs-pool/.git ]; then
  retry_command git clone https://github.com/MoneroOcean/nodejs-pool.git
fi
cd /home/user/nodejs-pool
if [ ! -d node_modules ]; then
  JOBS=$(nproc) install_node_dependencies
fi
command -v pm2 >/dev/null 2>&1 || retry_command npm install -g pm2 --min-release-age=7
retry_command pm2 install pm2-logrotate
if [ ! -f cert.key ] || [ ! -f cert.pem ]; then
  openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
fi
# A leaf is not allowed to accept miners until its copied production config,
# certificates, firewall rules, and relay services have been verified.
# pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
EOF

if [ -z "$TARI_EXTERNAL_IP" ]; then
  systemctl start xtm xtm_mm
else
  systemctl start xtm_mm
fi

wait_for_monero_sync
if [ -z "$TARI_EXTERNAL_IP" ]; then
  wait_for_tari_sync
fi

# Keep the administrator home private while granting monerod traversal only
# to its reviewed notification script. Notifications begin after initial sync.
test -x /home/user/nodejs-pool/block_notify.sh
setfacl --modify user:monerodaemon:--x /home/user
write_monero_service enable-block-notify
systemctl daemon-reload
systemctl restart monero
systemctl start xtm_mm
