#!/bin/bash -ex

NODEJS_VERSION="${NODEJS_VERSION:-v24.15.0}"
MONERO_REPO_URL="${MONERO_REPO_URL:-https://github.com/monero-project/monero.git}"
MONERO_RELEASE_TAG="${MONERO_RELEASE_TAG:-v0.18.5.1}"
WWW_DNS="${WWW_DNS:-moneroocean.stream}"
API_DNS="${API_DNS:-api.moneroocean.stream}"
CF_DNS_API_TOKEN="${CF_DNS_API_TOKEN:-n/a}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-support@moneroocean.stream}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.4.1}"
TARI_REPO_URL="${TARI_REPO_URL:-https://github.com/tari-project/tari.git}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"
TARI_INSTALL_DIR="${TARI_INSTALL_DIR:-/usr/local/src/tari}"
TARI_USER="${TARI_USER:-taridaemon}"
TARI_HOME="${TARI_HOME:-/home/$TARI_USER}"
TARI_CONFIG_PATCH_URL="${TARI_CONFIG_PATCH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh}"
TARI_WALLET_PAYMENT_ADDRESS="${TARI_WALLET_PAYMENT_ADDRESS:-12FrDe5cUauXdMeCiG1DU3XQZdShjFd9A4p9agxsddVyAwpmz73x4b2Qdy5cPYaGmKNZ6g1fbCASJpPxnjubqjvHDa5}"
TARI_PRUNING_HORIZON="${TARI_PRUNING_HORIZON:-10000}"
TARI_PRUNING_INTERVAL="${TARI_PRUNING_INTERVAL:-50}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this script as root"
  exit 1
fi
if [ "$#" -gt 0 ]; then
  echo "Please configure deploy.bash with environment variables: WWW_DNS, API_DNS, CF_DNS_API_TOKEN, CERTBOT_EMAIL"
  exit 1
fi
if [ -n "${TARI_EXTERNAL_IP+x}" ]; then
  echo "deploy.bash does not support TARI_EXTERNAL_IP; it is only for leaf.bash external base node gRPC"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
retry_command() { for i in 1 2 3 4 5; do "$@" && return 0; [ "$i" = 5 ] || sleep $((i * 5)); done; return 1; }
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

configure_unattended_upgrade_blacklist() {
  install -d -m 755 /etc/apt/apt.conf.d
  cat >/etc/apt/apt.conf.d/52moneroocean-unattended-upgrades-blacklist <<'EOF'
// MySQL package maintainer scripts stop/restart mysql during upgrades.
// Keep database upgrades manual so pool operators control the downtime.
Unattended-Upgrade::Package-Blacklist {
  "^mysql-server$";
  "^mysql-server-[0-9].*$";
  "^mysql-server-core-[0-9].*$";
  "^mysql-client-[0-9].*$";
  "^mysql-client-core-[0-9].*$";
  "^mysql-common$";
};
EOF
  rm -f /etc/needrestart/conf.d/moneroocean-critical.conf
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
    if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
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
  TARI_TARGET_NETWORK="$TARI_NETWORK" cargo build --release --locked -p minotari_node -p minotari_merge_mining_proxy
  if [ ! -f "$TARI_HOME/.tari/mainnet/config/config.toml" ]; then
    sudo -u "$TARI_USER" env HOME="$TARI_HOME" "$TARI_INSTALL_DIR/target/release/minotari_node" --init --network mainnet --non-interactive-mode --disable-splash-screen
  fi
}

patch_tari_config() {
  local patcher="/usr/local/src/patch-tari-config.sh"
  local config="$TARI_HOME/.tari/mainnet/config/config.toml"
  local args=("$config" "--no-backup" "--pruning-horizon" "$TARI_PRUNING_HORIZON" "--pruning-interval" "$TARI_PRUNING_INTERVAL")
  retry_command curl -fsSL -o "$patcher" "$TARI_CONFIG_PATCH_URL"
  chmod 755 "$patcher"
  args+=("--wallet-payment-address" "$TARI_WALLET_PAYMENT_ADDRESS")
  "$patcher" "${args[@]}"
  chown "$TARI_USER:$TARI_USER" "$config"
}

build_monero_release() {
  USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release
  git rev-parse HEAD >build/release/.moneroocean-build-commit
}

monero_build_is_current() {
  if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
    [ -x /usr/local/src/monero/build/release/bin/monerod ]
    return
  fi
  [ -x /usr/local/src/monero/build/release/bin/monerod ] &&
    [ -r build/release/.moneroocean-build-commit ] &&
    [ "$(cat build/release/.moneroocean-build-commit)" = "$(git rev-parse HEAD)" ]
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

configure_unattended_upgrade_blacklist
configure_overcommit
configure_swap
configure_journald_retention

retry_command apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
  echo "Skipping apt full-upgrade in test mode"
else
  retry_command apt-get -o Acquire::Retries=3 full-upgrade -y
fi
retry_command apt-get -o Acquire::Retries=3 install -y ca-certificates curl wget openssl sudo ufw nginx git vim unzip python3 g++ make libc6-dev cmake pkg-config autoconf automake libtool libssl-dev libsqlite3-dev sqlite3 clang libc++-dev libc++abi-dev libprotobuf-dev protobuf-compiler libncurses-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev mysql-server
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
for rule in ssh 443 18141 18189; do
  ufw allow "$rule"
done
ufw --force enable

printf 'colorscheme desert\nset fo-=ro\n' >/root/.vimrc
install -m 644 -o user -g user /root/.vimrc /home/user/.vimrc
mkdir -p /etc/letsencrypt
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
  cat >/etc/letsencrypt/options-ssl-nginx.conf <<'EOF'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
EOF
else
  snap install --classic certbot
  snap set certbot trust-plugin-with-root=ok
  snap install certbot-dns-cloudflare
  find /snap/certbot -name options-ssl-nginx.conf | xargs -I{} cp {} /etc/letsencrypt/options-ssl-nginx.conf
fi
echo "dns_cloudflare_api_token=$CF_DNS_API_TOKEN" >/root/dns_cloudflare_api_token.ini
chmod 600 /root/dns_cloudflare_api_token.ini
for dns in "$WWW_DNS" "$API_DNS"; do
  if [ ! -f "/etc/letsencrypt/live/$dns/fullchain.pem" ]; then
    certbot certonly --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --dns-cloudflare --dns-cloudflare-propagation-seconds 30 --dns-cloudflare-credentials /root/dns_cloudflare_api_token.ini -d "$dns"
  fi
done
install -d -m 755 /etc/nginx/conf.d
cat >/etc/nginx/conf.d/moneroocean-gzip.conf <<'EOF'
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css application/json application/javascript application/xml application/xml+rss image/svg+xml text/javascript text/xml;
EOF
cat >/etc/nginx/sites-enabled/default <<EOF
server {
	listen 80;
	location /leafApi {
		proxy_pass http://localhost:8000;
		proxy_redirect off;
	}
	gzip on;
}

# Per-client rate limit for the data-heavy API routes. Keyed on the real client IP
# (Cloudflare's CF-Connecting-IP; the origin only accepts Cloudflare traffic) so a single
# client cannot flood the paginated/scan endpoints. Cheap cached routes under "/" stay free.
limit_req_zone \$http_cf_connecting_ip zone=api_ip:32m rate=5r/s;
server {
	listen 443 ssl;
	server_name $API_DNS;
	location /miner/ {
		limit_req zone=api_ip burst=30 nodelay;
		proxy_pass http://localhost:8001;
		proxy_redirect off;
	}
	location /pool/ {
		limit_req zone=api_ip burst=30 nodelay;
		proxy_pass http://localhost:8001;
		proxy_redirect off;
	}
	location / {
		proxy_pass http://localhost:8001;
		proxy_redirect off;
	}
	gzip on;
	ssl_certificate /etc/letsencrypt/live/$API_DNS/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/$API_DNS/privkey.pem;
	include /etc/letsencrypt/options-ssl-nginx.conf;
	# Redirect non-https traffic to https
	if (\$scheme != "https") {
		return 301 https://\$host\$request_uri;
	}
}

server {
	listen 443 ssl;
	server_name $WWW_DNS;
	root /var/www/mo-pool-ui;
	index index.html;
	gzip on;

	location = /robots.txt {
		default_type text/plain;
		return 200 "User-agent: *\nAllow: /\n";
	}

	location ~* \.(?:css|js|mjs|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$ {
		expires 1y;
		try_files \$uri =404;
	}

	location / {
		expires -1;
		try_files \$uri \$uri/ /index.html;
	}

	# The script-src hash allows mo-pool-ui's inline JSON-LD. If that block changes,
	# rebuild mo-pool-ui and recompute with: ./csp-hash.sh build/index.html
	add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'sha256-YJwF1S8EFN7IS7+UkTTZIZ2c/qaIbutNwq2bdAhdokc='; style-src 'self'; img-src 'self' data:; connect-src https://$API_DNS https://stats.uptimerobot.com; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests" always;
	add_header X-Frame-Options "DENY" always;
	add_header X-Content-Type-Options "nosniff" always;
	add_header Referrer-Policy "strict-origin-when-cross-origin" always;
	add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-write=(self)" always;
	ssl_certificate /etc/letsencrypt/live/$WWW_DNS/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/$WWW_DNS/privkey.pem;
	include /etc/letsencrypt/options-ssl-nginx.conf;
	# Redirect non-https traffic to https
	if (\$scheme != "https") {
		return 301 https://\$host\$request_uri;
	}
}
EOF
chown -R www-data:www-data /var/www
chmod g+s /var/www
systemctl restart nginx
checkout_repo_ref "$MONERO_REPO_URL" /usr/local/src/monero "$MONERO_RELEASE_TAG"
retry_command git submodule update --init
if ! monero_build_is_current; then
  rm -rf build
  build_monero_release
fi

su -l user -s /bin/bash <<EOF
set -ex
mkdir -p ~/wallets
cd ~/wallets
test -f ~/wallets/wallet_pass || echo pass >~/wallets/wallet_pass
if [ ! -f ~/wallets/wallet.address.txt ]; then
  echo 1 | /usr/local/src/monero/build/release/bin/monero-wallet-cli --offline --create-address-file --generate-new-wallet ~/wallets/wallet --password-file ~/wallets/wallet_pass --command address
fi
if [ ! -f ~/wallets/wallet_fee.address.txt ]; then
  echo 1 | /usr/local/src/monero/build/release/bin/monero-wallet-cli --offline --create-address-file --generate-new-wallet ~/wallets/wallet_fee --password-file ~/wallets/wallet_pass --command address
fi
EOF
echo; echo; echo
if [ ! -f /root/.moneroocean-wallet-seeds-confirmed ]; then
  read -p "*** Write down your seeds for wallet and wallet_fee listed above and press ENTER to continue ***"
  touch /root/.moneroocean-wallet-seeds-confirmed
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
clone_repo_once https://github.com/MoneroOcean/grpc-json-proxy.git /usr/local/src/grpc-json-proxy
patch_tari_config

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

cat >/lib/systemd/system/xtm_mm.service <<EOF
[Unit]
Description=Tari Merge Mining Daemon
After=network.target monero.service xtm.service
PartOf=monero.service xtm.service

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
systemctl enable monero xtm xtm_mm
systemctl start monero
wait_for_monero_sync
rm -f /etc/mysql/conf.d/mysql-native-password.cnf
if mysqld --verbose --help 2>/dev/null | grep -Fq -- "--mysql-native-password[=name]"; then
  cat >/etc/mysql/conf.d/mysql-native-password.cnf <<'EOF'
[mysqld]
mysql-native-password=ON
EOF
fi
systemctl restart mysql
for i in $(seq 1 30); do
  mysqladmin ping >/dev/null 2>&1 && break
  sleep 1
done
mysqladmin ping >/dev/null 2>&1
ROOT_SQL_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
if mysql -Nse "SHOW PLUGINS" | awk '$1=="mysql_native_password" && $2=="ACTIVE" { found=1 } END { exit !found }'; then
  ROOT_SQL_AUTH="ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '$ROOT_SQL_PASS';"
  USER_SQL_CMD="sudo mysql -u root --password='$ROOT_SQL_PASS'"
else
  ROOT_SQL_AUTH="ALTER USER 'root'@'localhost' IDENTIFIED BY '$ROOT_SQL_PASS';"
  USER_SQL_CMD="sudo mysql --protocol=socket -u root"
fi
(cat <<EOF
$ROOT_SQL_AUTH
FLUSH PRIVILEGES;
EOF
) | {
  if mysql --protocol=socket -u root -e "SELECT 1" >/dev/null 2>&1; then
    mysql --protocol=socket -u root
  elif test -f /root/mysql_pass; then
    mysql -u root --password="$(cat /root/mysql_pass)"
  else
    mysql -u root
  fi
}
echo $ROOT_SQL_PASS >/root/mysql_pass
chmod 600 /root/mysql_pass
grep max_connections /etc/mysql/my.cnf || cat >>/etc/mysql/my.cnf <<'EOF'
[mysqld]
max_connections = 10000
EOF
systemctl restart mysql

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
sudo install -m 755 "\$NODE_BINARY" /usr/local/bin/node
sudo ln -sfn /usr/local/bin/node /usr/bin/node
test -x /usr/bin/npm || sudo ln -s "\$(command -v npm)" /usr/bin/npm
sudo chown -R user:user /usr/local/src/grpc-json-proxy
cd /usr/local/src/grpc-json-proxy
if [ ! -d node_modules ]; then
  retry_command npm install --omit=dev --min-release-age=7
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
# install lmdb tools
( cd /home/user
  if [ ! -d node-lmdb/.git ]; then
    retry_command git clone https://github.com/Venemo/node-lmdb.git
  fi
  cd node-lmdb
  git checkout c3135a3809da1d64ce1f0956b37b618711e33519
  cd dependencies/lmdb/libraries/liblmdb
  test -x mdb_copy || make -j $(nproc)
  mkdir -p /home/user/.bin
  grep -Fq 'export PATH=/home/user/.bin:$PATH' /home/user/.bashrc || {
    echo >>/home/user/.bashrc
    echo 'export PATH=/home/user/.bin:$PATH' >>/home/user/.bashrc
  }
  for i in mdb_copy mdb_dump mdb_load mdb_stat; do cp \$i /home/user/.bin/; done
)
mkdir -p /home/user/pool_db
if [ ! -f config.json ]; then
  sed -r 's#("db_storage_path": ).*#\1"/home/user/pool_db/",#' config_example.json >config.json
fi
if ! $USER_SQL_CMD -e "USE pool" >/dev/null 2>&1; then
  $USER_SQL_CMD <deployment/base.sql
fi
$USER_SQL_CMD -e "INSERT IGNORE INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'authKey', '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)', 'string', 'Auth key sent with all Websocket frames for validation.')"
$USER_SQL_CMD -e "INSERT IGNORE INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'secKey', '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)', 'string', 'Secret key for signing miner email unsubscribe links.')"
$USER_SQL_CMD -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet.address.txt)' WHERE module = 'pool' and item = 'address';"
$USER_SQL_CMD -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet_fee.address.txt)' WHERE module = 'payout' and item = 'feeAddress';"
pm2 describe api >/dev/null 2>&1 || pm2 start init.js --name=api --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=api
pm2 describe monero-wallet-rpc >/dev/null 2>&1 || pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --rpc-bind-port 18082 --password-file /home/user/wallets/wallet_pass --wallet-file /home/user/wallets/wallet --trusted-daemon --disable-rpc-login
sleep 30
pm2 describe block_manager >/dev/null 2>&1 || pm2 start init.js --name=block_manager --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z"  -- --module=block_manager
pm2 describe worker >/dev/null 2>&1 || pm2 start init.js --name=worker --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --node-args="--max_old_space_size=8192" -- --module=worker
pm2 describe payments >/dev/null 2>&1 || pm2 start init.js --name=payments --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --no-autorestart -- --module=payments
pm2 describe remote_share >/dev/null 2>&1 || pm2 start init.js --name=remote_share --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=remote_share
pm2 describe long_runner >/dev/null 2>&1 || pm2 start init.js --name=long_runner --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=long_runner
#pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
sleep 20
pm2 describe pool_stats >/dev/null 2>&1 || pm2 start init.js --name=pool_stats --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool_stats
pm2 save
sudo env PATH=\$PATH:/home/user/.nvm/versions/node/\$NODEJS_VERSION/bin /home/user/.nvm/versions/node/\$NODEJS_VERSION/lib/node_modules/pm2/bin/pm2 startup systemd -u user --hp /home/user
cd /home/user
if [ ! -d /home/user/mo-pool-ui/.git ]; then
  retry_command git clone https://github.com/MoneroOcean/mo-pool-ui.git
fi
cd mo-pool-ui
if [ ! -d node_modules ]; then
  install_node_dependencies
fi
if [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "\${ID:-}" = "ubuntu" ] && [ "\${VERSION_ID:-}" = "26.04" ]; then
    export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64
  fi
fi
retry_command npx playwright install --with-deps chromium
retry_command npm run build
EOF

systemctl start xtm xtm_mm
wait_for_tari_sync

echo 'Frontend is installed in /home/user/mo-pool-ui and deployed to /var/www/mo-pool-ui. To rebuild it later, log in as "user" and run: cd ~/mo-pool-ui && npm ci && npm run build'
