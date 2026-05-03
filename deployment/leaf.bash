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
    args+=("--external-ip" "$TARI_EXTERNAL_IP")
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
retry_command apt-get -o Acquire::Retries=3 install -y ca-certificates curl openssl sudo ufw git vim unzip python3 g++ make libc-dev cmake libssl-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev
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
for rule in ssh 3333 5555 7777 9000; do
  ufw allow "$rule"
done
ufw --force enable

printf 'colorscheme desert\nset fo-=ro\n' >/root/.vimrc
install -m 644 -o user -g user /root/.vimrc /home/user/.vimrc
retry_command git clone https://github.com/monero-project/monero.git /usr/local/src/monero
cd /usr/local/src/monero
git checkout v0.18.4.6
retry_command git submodule update --init
USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release

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
retry_command git clone https://github.com/MoneroOcean/grpc-json-proxy.git /usr/local/src/grpc-json-proxy
patch_tari_config

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
systemctl enable monero xtm xtm_mm
systemctl start monero

sleep 30
echo "Please wait until Monero daemon is fully synced"
tail -f /home/monerodaemon/.bitmonero/bitmonero.log 2>/dev/null | grep Synced &
( tail -F -n0 /home/monerodaemon/.bitmonero/bitmonero.log & ) | grep -Eq "You are now synchronized with the network"
pkill -x tail 2>/dev/null || true
echo "Monero daemon is synced"

(cat <<EOF
set -ex
$(declare -f retry_command)
retry_command bash -lc 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash'
source /home/user/.nvm/nvm.sh
retry_command nvm install $NODEJS_VERSION
NODEJS_VERSION="\$(nvm version "$NODEJS_VERSION")"
nvm alias default "\$NODEJS_VERSION"
test -x /usr/bin/node || sudo ln -s "\$(command -v node)" /usr/bin/node
test -x /usr/bin/npm || sudo ln -s "\$(command -v npm)" /usr/bin/npm
sudo chown -R user:user /usr/local/src/grpc-json-proxy
cd /usr/local/src/grpc-json-proxy
retry_command npm install --omit=dev
cd /home/user
retry_command git clone https://github.com/MoneroOcean/nodejs-pool.git
cd /home/user/nodejs-pool
JOBS=$(nproc) retry_command npm install
command -v pm2 >/dev/null 2>&1 || retry_command npm install -g pm2
retry_command pm2 install pm2-logrotate
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
#pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
EOF
) | su user -l

systemctl start xtm xtm_mm
