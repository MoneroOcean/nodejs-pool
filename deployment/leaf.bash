#!/bin/bash -ex

NODEJS_VERSION="${NODEJS_VERSION:-v24.15.0}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.3.0}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"
TARI_INSTALL_DIR="${TARI_INSTALL_DIR:-/usr/local/src/tari}"
TARI_CONFIG_PATCH_URL="${TARI_CONFIG_PATCH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh}"
TARI_EXTERNAL_IP="${TARI_EXTERNAL_IP:-}"
TARI_WALLET_PAYMENT_ADDRESS="${TARI_WALLET_PAYMENT_ADDRESS:-12FrDe5cUauXdMeCiG1DU3XQZdShjFd9A4p9agxsddVyAwpmz73x4b2Qdy5cPYaGmKNZ6g1fbCASJpPxnjubqjvHDa5}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this script as root"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
retry_command() { for i in 1 2 3 4 5; do "$@" && return 0; [ "$i" = 5 ] || sleep $((i * 5)); done; return 1; }

clone_repo_once() {
  local repo="$1"
  local dest="$2"
  if [ -d "$dest/.git" ]; then
    return 0
  fi
  retry_command git clone "$repo" "$dest"
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

tari_release_arch() {
  case "${TARI_RELEASE_ARCH:-$(uname -m)}" in
    x86_64|amd64) echo x86_64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "Unsupported Tari release architecture: ${TARI_RELEASE_ARCH:-$(uname -m)}" >&2; return 1 ;;
  esac
}

tari_release_url() {
  local arch version api_url
  arch="$(tari_release_arch)"
  version="${TARI_RELEASE_TAG#v}"
  api_url="https://api.github.com/repos/tari-project/tari/releases/tags/$TARI_RELEASE_TAG"
  python3 - "$api_url" "$version" "$TARI_NETWORK" "$arch" <<'PY'
import json
import re
import sys
import urllib.request

api_url, version, network, arch = sys.argv[1:]
with urllib.request.urlopen(api_url) as response:
    release = json.load(response)
pattern = re.compile(rf"^tari_suite-{re.escape(version)}-{re.escape(network)}-[^-]+-linux-{re.escape(arch)}\.zip$")
matches = [asset for asset in release.get("assets", []) if pattern.match(asset.get("name", ""))]
if len(matches) != 1:
    names = ", ".join(asset.get("name", "") for asset in release.get("assets", []))
    raise SystemExit(f"Expected one Tari {network} linux-{arch} asset for {version}, found {len(matches)}. Assets: {names}")
print(matches[0]["browser_download_url"])
PY
}

install_tari_suite() {
  local tmp_zip release_url
  if [ -x "$TARI_INSTALL_DIR/minotari_node" ] && [ -x "$TARI_INSTALL_DIR/minotari_merge_mining_proxy" ]; then
    if [ ! -f /home/monerodaemon/.tari/mainnet/config/config.toml ]; then
      sudo -u monerodaemon env HOME=/home/monerodaemon "$TARI_INSTALL_DIR/minotari_node" --init --network mainnet --non-interactive-mode --disable-splash-screen
    fi
    return 0
  fi
  rm -rf "$TARI_INSTALL_DIR"
  install -d "$TARI_INSTALL_DIR"
  tmp_zip="$(mktemp)"
  release_url="$(tari_release_url)"
  retry_command curl -fsSL -o "$tmp_zip" "$release_url"
  unzip -q "$tmp_zip" -d "$TARI_INSTALL_DIR"
  rm -f "$tmp_zip"
  chmod 755 "$TARI_INSTALL_DIR"/minotari_*
  sudo -u monerodaemon env HOME=/home/monerodaemon "$TARI_INSTALL_DIR/minotari_node" --init --network mainnet --non-interactive-mode --disable-splash-screen
}
patch_tari_config() {
  local patcher="/usr/local/src/patch-tari-config.sh"
  local config="/home/monerodaemon/.tari/mainnet/config/config.toml"
  local args=("$config" "--no-backup")
  retry_command curl -fsSL -o "$patcher" "$TARI_CONFIG_PATCH_URL"
  chmod 755 "$patcher"
  if [ -n "$TARI_EXTERNAL_IP" ]; then
    args+=("--base-node-grpc-ip" "$TARI_EXTERNAL_IP")
  fi
  args+=("--wallet-payment-address" "$TARI_WALLET_PAYMENT_ADDRESS")
  "$patcher" "${args[@]}"
  chown monerodaemon:monerodaemon "$config"
}

retry_command apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
  echo "Skipping apt full-upgrade in test mode"
else
  retry_command apt-get -o Acquire::Retries=3 full-upgrade -y
fi
retry_command apt-get -o Acquire::Retries=3 install -y ca-certificates curl wget openssl sudo ufw git vim unzip python3 g++ make libc-dev cmake libssl-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev libcap2-bin
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
if [ ! -x /usr/local/src/monero/build/release/bin/monerod ]; then
  git checkout v0.18.4.6
  retry_command git submodule update --init
  USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release
fi

cat >/lib/systemd/system/monero.service <<'EOF'
[Unit]
Description=Monero Daemon
After=network.target

[Service]
ExecStart=/usr/local/src/monero/build/release/bin/monerod --hide-my-port --prune-blockchain --enable-dns-blocklist --no-zmq --out-peers 64 --non-interactive --restricted-rpc --rpc-bind-port=18083 --block-notify '/bin/bash /home/user/nodejs-pool/block_notify.sh'
Restart=always
User=monerodaemon
Nice=10
CPUQuota=400%

[Install]
WantedBy=multi-user.target
EOF

id -u monerodaemon >/dev/null 2>&1 || useradd -m monerodaemon -d /home/monerodaemon
install_tari_suite
if [ -z "$TARI_EXTERNAL_IP" ]; then
  clone_repo_once https://github.com/MoneroOcean/grpc-json-proxy.git /usr/local/src/grpc-json-proxy
fi
patch_tari_config

if [ -z "$TARI_EXTERNAL_IP" ]; then
  cat >/lib/systemd/system/xtm.service <<'EOF'
[Unit]
Description=Tari Daemon
After=network.target

[Service]
ExecStart=/bin/bash -c "(sleep 2; node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18146 18142) & (sleep 2; node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18148 18142) & /usr/local/src/tari/minotari_node --non-interactive-mode --watch status --disable-splash-screen"
Restart=always
User=monerodaemon
Nice=10
CPUQuota=400%

[Install]
WantedBy=multi-user.target
EOF
fi

cat >/lib/systemd/system/xtm_mm.service <<'EOF'
[Unit]
Description=Tari Merge Mining Daemon
After=network.target

[Service]
ExecStart=/usr/local/src/tari/minotari_merge_mining_proxy --non-interactive-mode
Restart=always
RestartSec=3s
StartLimitBurst=0
User=monerodaemon
Nice=10
CPUQuota=400%

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
