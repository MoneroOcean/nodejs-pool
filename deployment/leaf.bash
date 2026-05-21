#!/bin/bash -e

NODEJS_VERSION="${NODEJS_VERSION:-v24.15.0}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.3.1}"
TARI_REPO_URL="${TARI_REPO_URL:-https://github.com/tari-project/tari.git}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"
TARI_INSTALL_DIR="${TARI_INSTALL_DIR:-/usr/local/src/tari}"
TARI_USER="${TARI_USER:-taridaemon}"
TARI_HOME="${TARI_HOME:-/home/$TARI_USER}"
TARI_CONFIG_PATCH_URL="${TARI_CONFIG_PATCH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh}"
TARI_EXTERNAL_IP="${TARI_EXTERNAL_IP:-}"
TARI_WALLET_PAYMENT_ADDRESS="${TARI_WALLET_PAYMENT_ADDRESS:-12FrDe5cUauXdMeCiG1DU3XQZdShjFd9A4p9agxsddVyAwpmz73x4b2Qdy5cPYaGmKNZ6g1fbCASJpPxnjubqjvHDa5}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this script as root"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
retry_command() { for i in 1 2 3 4 5; do "$@" && return 0; [ "$i" = 5 ] || sleep $((i * 5)); done; return 1; }

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
    if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
      echo "Skipping active overcommit sysctl apply in test mode"
      return 0
    fi
    return 1
  fi
}

configure_swap() {
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
        if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
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
HUGEPAGES_GROUP="${HUGEPAGES_GROUP:-hugepages}"
MONERO_RANDOMX_HUGEPAGES="${MONERO_RANDOMX_HUGEPAGES:-384}"
MONERO_LOG_CATEGORIES="${MONERO_LOG_CATEGORIES:-*:ERROR,cn:ERROR,blockchain:ERROR,verify:ERROR}"

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

wait_for_monero_sync() {
  echo "Please wait until Monero daemon is fully synced"
  for _ in $(seq 1 360); do
    if rpc_synced http://127.0.0.1:18083/json_rpc get_info; then
      echo "Monero daemon is synced"
      return 0
    fi
    sleep 10
  done
  echo "Timed out waiting for Monero daemon sync" >&2
  return 1
}

wait_for_tari_sync() {
  echo "Please wait until Tari daemon is fully synced"
  for _ in $(seq 1 360); do
    if rpc_synced http://127.0.0.1:18146/json_rpc GetTipInfo; then
      echo "Tari daemon is synced"
      return 0
    fi
    sleep 10
  done
  echo "Timed out waiting for Tari daemon sync" >&2
  return 1
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
  TARI_TARGET_NETWORK="$TARI_NETWORK" cargo build --release -p minotari_node -p minotari_merge_mining_proxy
  if [ ! -f "$TARI_HOME/.tari/mainnet/config/config.toml" ]; then
    sudo -u "$TARI_USER" env HOME="$TARI_HOME" "$TARI_INSTALL_DIR/target/release/minotari_node" --init --network mainnet --non-interactive-mode --disable-splash-screen
  fi
}
patch_tari_config() {
  local patcher="/usr/local/src/patch-tari-config.sh"
  local config="$TARI_HOME/.tari/mainnet/config/config.toml"
  local args=("$config" "--no-backup")
  retry_command curl -fsSL -o "$patcher" "$TARI_CONFIG_PATCH_URL"
  chmod 755 "$patcher"
  if [ -n "$TARI_EXTERNAL_IP" ]; then
    args+=("--base-node-grpc-ip" "$TARI_EXTERNAL_IP")
  fi
  args+=("--wallet-payment-address" "$TARI_WALLET_PAYMENT_ADDRESS")
  "$patcher" "${args[@]}"
  chown "$TARI_USER:$TARI_USER" "$config"
}

build_monero_release() {
  USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release
}

monero_build_is_current() {
  [ -x /usr/local/src/monero/build/release/bin/monerod ]
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
    if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
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

retry_command apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
  echo "Skipping apt full-upgrade in test mode"
else
  retry_command apt-get -o Acquire::Retries=3 full-upgrade -y
fi
retry_command apt-get -o Acquire::Retries=3 install -y ca-certificates curl wget openssl sudo ufw git vim unzip python3 g++ make libc-dev cmake pkg-config autoconf automake libtool libssl-dev libsqlite3-dev sqlite3 clang libc++-dev libc++abi-dev libprotobuf-dev protobuf-compiler libncurses5-dev libncursesw5-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev libcap2-bin
timedatectl set-timezone Etc/UTC

id -u user >/dev/null 2>&1 || adduser --disabled-password --gecos "" user
grep -q "user ALL=(ALL) NOPASSWD:ALL" /etc/sudoers || echo "user ALL=(ALL) NOPASSWD:ALL" >>/etc/sudoers
install -d -m 700 -o user -g user /home/user/.ssh
if [ -f "/root/.ssh/authorized_keys" ]; then
  mv /root/.ssh/authorized_keys /home/user/.ssh/authorized_keys
  chown user:user /home/user/.ssh/authorized_keys
  chmod 600 /home/user/.ssh/authorized_keys
  sed -i 's/#\?PasswordAuthentication yes/PasswordAuthentication no/g' /etc/ssh/sshd_config
  sed -i 's/#\?PermitRootLogin .\+/PermitRootLogin no/g' /etc/ssh/sshd_config
  sed -i 's/#\?PermitEmptyPasswords .\+/PermitEmptyPasswords no/g' /etc/ssh/sshd_config
  service ssh restart
fi

ufw default deny incoming
ufw default allow outgoing
for rule in ssh 3333 5555 7777 18141 18189; do
  ufw allow "$rule"
done
ufw --force enable

printf 'colorscheme desert\nset fo-=ro\n' >/root/.vimrc
install -m 644 -o user -g user /root/.vimrc /home/user/.vimrc
clone_repo_once https://github.com/monero-project/monero.git /usr/local/src/monero
cd /usr/local/src/monero
git checkout v0.18.4.6
retry_command git submodule update --init
if ! monero_build_is_current; then
  rm -rf build
  build_monero_release
fi

id -u monerodaemon >/dev/null 2>&1 || useradd -m monerodaemon -d /home/monerodaemon
ensure_tari_user
configure_monero_hugepages

cat >/lib/systemd/system/monero.service <<EOF
[Unit]
Description=Monero Daemon
After=network.target

[Service]
Environment=MALLOC_ARENA_MAX=2
SupplementaryGroups=$HUGEPAGES_GROUP
LimitMEMLOCK=infinity
ExecStart=/usr/local/src/monero/build/release/bin/monerod --rpc-bind-ip=127.0.0.1 --rpc-bind-port=18083 --hide-my-port --prune-blockchain --enable-dns-blocklist --no-zmq --out-peers 64 --non-interactive --log-level '$MONERO_LOG_CATEGORIES' --block-notify '/bin/bash /home/user/nodejs-pool/block_notify.sh'
Restart=always
User=monerodaemon
Nice=10
CPUQuota=400%

[Install]
WantedBy=multi-user.target
EOF

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
ExecStart=/bin/bash -c "(sleep 2; node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18146 18142) & (sleep 2; node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18148 18142) & /usr/local/src/tari/target/release/minotari_node --non-interactive-mode --watch status --disable-splash-screen"
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
wait_for_monero_sync

(cat <<EOF
set -ex
$(declare -f retry_command)
if [ ! -f /home/user/.nvm/nvm.sh ]; then
  retry_command bash -lc 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash'
fi
source /home/user/.nvm/nvm.sh
retry_command nvm install $NODEJS_VERSION
NODEJS_VERSION="\$(nvm version "$NODEJS_VERSION")"
nvm alias default "\$NODEJS_VERSION"
NODE_BINARY="\$(command -v node)"
test -x /usr/bin/node || sudo ln -s "\$NODE_BINARY" /usr/bin/node
test -x /usr/bin/npm || sudo ln -s "\$(command -v npm)" /usr/bin/npm
sudo setcap cap_net_bind_service=+ep "\$NODE_BINARY"
if [ -d /usr/local/src/grpc-json-proxy ]; then
  sudo chown -R user:user /usr/local/src/grpc-json-proxy
  cd /usr/local/src/grpc-json-proxy
  if [ ! -d node_modules ]; then
    retry_command npm install --omit=dev
  fi
fi
cd /home/user
if [ ! -d /home/user/nodejs-pool/.git ]; then
  retry_command git clone https://github.com/MoneroOcean/nodejs-pool.git
fi
cd /home/user/nodejs-pool
if [ ! -d node_modules ]; then
  JOBS=$(nproc) retry_command npm install
fi
command -v pm2 >/dev/null 2>&1 || retry_command npm install -g pm2
retry_command pm2 install pm2-logrotate
if [ ! -f cert.key ] || [ ! -f cert.pem ]; then
  openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
fi
#pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
EOF
) | su user -l

if [ -z "$TARI_EXTERNAL_IP" ]; then
  systemctl start xtm xtm_mm
  wait_for_tari_sync
else
  systemctl start xtm_mm
fi
