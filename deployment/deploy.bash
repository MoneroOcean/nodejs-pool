#!/bin/bash
set -Eeuo pipefail

# The common helper is bundled beside this script in repository checkouts.
# Curl-pipe installs have no reliable source path, so fetch that helper into a
# private temporary file instead of trusting the caller's working directory.
COMMON_BASH_URL="${COMMON_BASH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/common.bash}"
COMMON_TEMP_FILE=""
cleanup_common() {
  [ -z "${COMMON_TEMP_FILE:-}" ] || rm -f -- "$COMMON_TEMP_FILE"
}
trap cleanup_common EXIT
load_common() {
  local script_path="${BASH_SOURCE[0]:-}"
  local script_dir=""
  local common_path=""
  if [ -n "$script_path" ] && [ -f "$script_path" ]; then
    script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd)"
  fi
  if [ -n "$script_dir" ] && [ -f "$script_dir/common.bash" ]; then
    common_path="$script_dir/common.bash"
  else
    COMMON_TEMP_FILE="$(mktemp)"
    chmod 600 "$COMMON_TEMP_FILE"
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      "$COMMON_BASH_URL" -o "$COMMON_TEMP_FILE"
    common_path="$COMMON_TEMP_FILE"
  fi
  # shellcheck source=/dev/null
  source "$common_path"
  if [ "${MONEROOCEAN_COMMON_API_VERSION:-}" != "1" ]; then
    echo "Unsupported deployment common helper API" >&2
    return 1
  fi
}
load_common
if [ "${POOL_DEPLOY_LOAD_COMMON_ONLY:-0}" = "1" ]; then
  exit 0
fi

NODEJS_VERSION="${NODEJS_VERSION:-v24.15.0}"
MONERO_REPO_URL="${MONERO_REPO_URL:-https://github.com/monero-project/monero.git}"
MONERO_RELEASE_TAG="${MONERO_RELEASE_TAG:-v0.18.5.1}"
WWW_DNS="${WWW_DNS:-moneroocean.stream}"
API_DNS="${API_DNS:-api.moneroocean.stream}"
CF_DNS_API_TOKEN="${CF_DNS_API_TOKEN:-n/a}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-support@moneroocean.stream}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.6.0}"
TARI_REPO_URL="${TARI_REPO_URL:-https://github.com/tari-project/tari.git}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"
TARI_INSTALL_DIR="${TARI_INSTALL_DIR:-/usr/local/src/tari}"
TARI_USER="${TARI_USER:-taridaemon}"
TARI_HOME="${TARI_HOME:-/home/$TARI_USER}"
TARI_CONFIG_PATCH_URL="${TARI_CONFIG_PATCH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh}"
TARI_WALLET_PAYMENT_ADDRESS="${TARI_WALLET_PAYMENT_ADDRESS:-}"
TARI_PRUNING_HORIZON="${TARI_PRUNING_HORIZON:-10000}"
TARI_PRUNING_INTERVAL="${TARI_PRUNING_INTERVAL:-50}"
POOL_CONNTRACK_MAX="${POOL_CONNTRACK_MAX:-1048576}"
POOL_DEPLOY_PREPARE="${POOL_DEPLOY_PREPARE:-0}"
POOL_HOSTNAME="${POOL_HOSTNAME:-pool}"

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
if [[ ! "$POOL_CONNTRACK_MAX" =~ ^[1-9][0-9]*$ ]]; then
  echo "POOL_CONNTRACK_MAX must be a positive integer" >&2
  exit 1
fi
if [[ "$POOL_DEPLOY_PREPARE" != 0 && "$POOL_DEPLOY_PREPARE" != 1 ]]; then
  echo "POOL_DEPLOY_PREPARE must be 0 or 1" >&2
  exit 1
fi
if [[ ! "$POOL_HOSTNAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  echo "POOL_HOSTNAME contains invalid characters" >&2
  exit 1
fi
if [[ ! "$TARI_NETWORK" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "TARI_NETWORK contains invalid characters" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# Keep the replacement host's identity explicit. This is intentionally local
# to the host running the installer and does not touch DNS or the old pool.
if [ "${POOL_DEPLOY_TEST_MODE:-0}" != "1" ]; then
  if command -v hostnamectl >/dev/null 2>&1; then
    hostnamectl set-hostname "$POOL_HOSTNAME" >/dev/null 2>&1 || hostname "$POOL_HOSTNAME"
  else
    hostname "$POOL_HOSTNAME"
  fi
fi

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
}

TARI_MEMORY_HIGH="${TARI_MEMORY_HIGH:-$(default_tari_memory_high)}"
TARI_MEMORY_SWAP_MAX="${TARI_MEMORY_SWAP_MAX:-768M}"
TARI_MM_MEMORY_HIGH="${TARI_MM_MEMORY_HIGH:-1200M}"
TARI_MM_MEMORY_SWAP_MAX="${TARI_MM_MEMORY_SWAP_MAX:-384M}"
validate_systemd_memory_limit "$TARI_MEMORY_HIGH" TARI_MEMORY_HIGH
validate_systemd_memory_limit "$TARI_MEMORY_SWAP_MAX" TARI_MEMORY_SWAP_MAX
validate_systemd_memory_limit "$TARI_MM_MEMORY_HIGH" TARI_MM_MEMORY_HIGH
validate_systemd_memory_limit "$TARI_MM_MEMORY_SWAP_MAX" TARI_MM_MEMORY_SWAP_MAX
HUGEPAGES_GROUP="${HUGEPAGES_GROUP:-hugepages}"
MONERO_RANDOMX_HUGEPAGES="${MONERO_RANDOMX_HUGEPAGES:-384}"
MONERO_LOG_CATEGORIES="${MONERO_LOG_CATEGORIES:-*:ERROR,global:INFO,sync-info:INFO,cn:ERROR,blockchain:ERROR,verify:ERROR}"

wait_for_monero_sync() {
  [ "$POOL_DEPLOY_PREPARE" = 1 ] && { echo "Skipping Monero sync wait in prepare mode"; return 0; }
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
  [ "$POOL_DEPLOY_PREPARE" = 1 ] && { echo "Skipping Tari sync wait in prepare mode"; return 0; }
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

install_tari_suite() {
  ensure_rust_toolchain
  checkout_repo_ref "$TARI_REPO_URL" "$TARI_INSTALL_DIR" "$TARI_RELEASE_TAG"
  # Build-script paths are embedded in Cargo's target artifacts; remove stale
  # artifacts when the source tree has been moved or switched between releases.
  if [ ! -x "$TARI_INSTALL_DIR/target/release/minotari_node" ] || [ ! -x "$TARI_INSTALL_DIR/target/release/minotari_merge_mining_proxy" ]; then
    rm -rf "$TARI_INSTALL_DIR/target"
  fi
  TARI_TARGET_NETWORK="$TARI_NETWORK" cargo build --release --locked -p minotari_node -p minotari_merge_mining_proxy
  if [ ! -f "$TARI_HOME/.tari/$TARI_NETWORK/config/config.toml" ]; then
    sudo -u "$TARI_USER" env HOME="$TARI_HOME" "$TARI_INSTALL_DIR/target/release/minotari_node" --init --network "$TARI_NETWORK" --non-interactive-mode --disable-splash-screen
  fi
}

patch_tari_config() {
  local patcher="/usr/local/src/patch-tari-config.sh"
  local config="$TARI_HOME/.tari/$TARI_NETWORK/config/config.toml"
  local args=("$config" "--no-backup" "--pruning-horizon" "$TARI_PRUNING_HORIZON" "--pruning-interval" "$TARI_PRUNING_INTERVAL")
  retry_command curl -fsSL -o "$patcher" "$TARI_CONFIG_PATCH_URL"
  chmod 755 "$patcher"
  # An imported config is allowed to supply the address. A fresh deployment
  # must receive it explicitly; never silently fall back to a repository-wide
  # wallet address on a replacement host.
  if [ -z "$TARI_WALLET_PAYMENT_ADDRESS" ] && [ -f "$config" ]; then
    TARI_WALLET_PAYMENT_ADDRESS="$(awk '
      /^\[merge_mining_proxy\]$/ { in_section=1; next }
      /^\[/ { in_section=0 }
      in_section && /^[[:space:]]*wallet_payment_address[[:space:]]*=/ {
        sub(/^[^=]*=[[:space:]]*/, "")
        sub(/[[:space:]]*#.*/, "")
        gsub(/\047/, "")
        gsub(/"/, "")
        print
        exit
      }
    ' "$config" | tr -d '[:space:]')"
  fi
  if [ -z "$TARI_WALLET_PAYMENT_ADDRESS" ]; then
    echo "TARI_WALLET_PAYMENT_ADDRESS must be set (or present in the imported Tari config)" >&2
    return 1
  fi
  args+=("--wallet-payment-address" "$TARI_WALLET_PAYMENT_ADDRESS")
  "$patcher" "${args[@]}"
  chown "$TARI_USER:$TARI_USER" "$config"
}

build_monero_release() {
  USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release
  git rev-parse HEAD >build/release/.moneroocean-build-commit
  uname -m >build/release/.moneroocean-build-arch
}

monero_build_is_current() {
  if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
    [ -x /usr/local/src/monero/build/release/bin/monerod ]
    return
  fi
  [ -x /usr/local/src/monero/build/release/bin/monerod ] &&
    [ -r build/release/.moneroocean-build-commit ] &&
    [ "$(cat build/release/.moneroocean-build-commit)" = "$(git rev-parse HEAD)" ] &&
    [ -r build/release/.moneroocean-build-arch ] &&
    [ "$(cat build/release/.moneroocean-build-arch)" = "$(uname -m)" ]
}

configure_unattended_upgrade_blacklist
configure_needrestart_pm2_guard
configure_overcommit
configure_swap
configure_journald_retention

retry_command apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
  echo "Skipping apt full-upgrade in test mode"
else
  retry_command apt-get -o Acquire::Retries=3 full-upgrade -y
fi
retry_command apt-get -o Acquire::Retries=3 install -y ca-certificates curl wget openssl sudo ufw nginx git vim unzip python3 g++ make libc6-dev cmake pkg-config autoconf automake libtool libssl-dev libsqlite3-dev sqlite3 clang libc++-dev libc++abi-dev libprotobuf-dev protobuf-compiler libncurses-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev mysql-server kmod
configure_pool_conntrack
timedatectl set-timezone Etc/UTC

id -u user >/dev/null 2>&1 || adduser --disabled-password --gecos "" user
install -d -m 755 /etc/sudoers.d
printf 'user ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/user
chmod 440 /etc/sudoers.d/user
visudo -cf /etc/sudoers >/dev/null
install -d -m 700 -o user -g user /home/user/.ssh
if [ -f "/root/.ssh/authorized_keys" ]; then
  touch /home/user/.ssh/authorized_keys
  cat /root/.ssh/authorized_keys >>/home/user/.ssh/authorized_keys
  sort -u -o /home/user/.ssh/authorized_keys /home/user/.ssh/authorized_keys
  chown user:user /home/user/.ssh/authorized_keys
  chmod 600 /home/user/.ssh/authorized_keys
  if [ "$POOL_DEPLOY_PREPARE" != 1 ]; then
    sed -i 's/#\?PasswordAuthentication yes/PasswordAuthentication no/g' /etc/ssh/sshd_config
    sed -i 's/#\?PermitRootLogin .\+/PermitRootLogin no/g' /etc/ssh/sshd_config
    sed -i 's/#\?PermitEmptyPasswords .\+/PermitEmptyPasswords no/g' /etc/ssh/sshd_config
    sshd -t
    systemctl reload ssh
  fi
fi

ufw default deny incoming
ufw default allow outgoing
for rule in ssh 443 18189; do
  ufw allow "$rule"
done
ufw --force enable

printf 'colorscheme desert\nset fo-=ro\n' >/root/.vimrc
install -m 644 -o user -g user /root/.vimrc /home/user/.vimrc
mkdir -p /etc/letsencrypt
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ] || [ "$POOL_DEPLOY_PREPARE" = 1 ]; then
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
  [ "$POOL_DEPLOY_PREPARE" = 1 ] && continue
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
if [ "$POOL_DEPLOY_PREPARE" != 1 ]; then
  systemctl restart nginx
fi
checkout_repo_ref "$MONERO_REPO_URL" /usr/local/src/monero "$MONERO_RELEASE_TAG"
retry_command git submodule update --init
if ! monero_build_is_current; then
  rm -rf build
  build_monero_release
fi

if [ "$POOL_DEPLOY_PREPARE" = 1 ]; then
  # Wallet files are copied separately from the encrypted production mount.
  # Never generate a second wallet or block unattended preparation on a seed
  # prompt when the replacement is being staged.
  install -d -m 700 -o user -g user /home/user/wallets
  echo "Prepare mode: preserving imported wallet files; skipping wallet generation"
else
  su -l user -s /bin/bash <<EOF
set -e
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
fi

id -u monerodaemon >/dev/null 2>&1 || useradd -m monerodaemon -d /home/monerodaemon
ensure_tari_user
configure_monero_hugepages

if [ "$POOL_DEPLOY_PREPARE" = 1 ]; then
  write_monero_service
else
  write_monero_service enable-block-notify
fi

install_tari_suite
clone_repo_once https://github.com/MoneroOcean/grpc-json-proxy.git /usr/local/src/grpc-json-proxy
patch_tari_config

write_tari_service

write_tari_merge_mining_service "monero.service xtm.service"

systemctl daemon-reload
if [ "$POOL_DEPLOY_PREPARE" = 1 ]; then
  systemctl enable monero xtm
  systemctl disable xtm_mm >/dev/null 2>&1 || true
  systemctl stop xtm_mm >/dev/null 2>&1 || true
else
  systemctl enable monero xtm xtm_mm
fi
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
ROOT_SQL_PASS="$(openssl rand -hex 32)"
DEBIAN_MAINT_PASS=""
DEBIAN_MAINT_SQL=""
DEBIAN_MAINT_GRANT=""
MYSQL_ROOT_CMD=(mysql --protocol=socket -u root)
if [ -s /root/mysql_pass ]; then
  MYSQL_ROOT_CMD=(mysql -u root --password="$(cat /root/mysql_pass)")
fi
if [[ -r /etc/mysql/debian.cnf ]]; then
  DEBIAN_MAINT_PASS="$(
    awk -F= '
      /^[[:space:]]*password[[:space:]]*=/ {
        sub(/^[^=]*=[[:space:]]*/, "")
        print
        exit
      }
    ' /etc/mysql/debian.cnf
  )"
  # Debian-maintenance credentials are generated by the package and may contain
  # punctuation. Do not interpolate unsafe values into SQL; the fresh-host
  # installer does not need to rewrite this account.
  if [[ ! "$DEBIAN_MAINT_PASS" =~ ^[A-Za-z0-9._@+-]+$ ]]; then
    DEBIAN_MAINT_PASS=""
  fi
fi
if "${MYSQL_ROOT_CMD[@]}" -Nse "SHOW PLUGINS" | awk '$1=="mysql_native_password" && $2=="ACTIVE" { found=1 } END { exit !found }'; then
  ROOT_SQL_AUTH="ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '$ROOT_SQL_PASS';"
  USER_SQL_CMD="sudo mysql -u root --password='$ROOT_SQL_PASS'"
  if [[ -n "$DEBIAN_MAINT_PASS" ]]; then
    DEBIAN_MAINT_SQL="ALTER USER 'debian-sys-maint'@'localhost' IDENTIFIED WITH mysql_native_password BY '$DEBIAN_MAINT_PASS';"
    DEBIAN_MAINT_GRANT="GRANT ALL PRIVILEGES ON *.* TO 'debian-sys-maint'@'localhost' WITH GRANT OPTION;"
  fi
else
  ROOT_SQL_AUTH="ALTER USER 'root'@'localhost' IDENTIFIED BY '$ROOT_SQL_PASS';"
  USER_SQL_CMD="sudo mysql --protocol=socket -u root"
  if [[ -n "$DEBIAN_MAINT_PASS" ]]; then
    DEBIAN_MAINT_SQL="ALTER USER 'debian-sys-maint'@'localhost' IDENTIFIED BY '$DEBIAN_MAINT_PASS';"
    DEBIAN_MAINT_GRANT="GRANT ALL PRIVILEGES ON *.* TO 'debian-sys-maint'@'localhost' WITH GRANT OPTION;"
  fi
fi
(cat <<EOF
$ROOT_SQL_AUTH
$DEBIAN_MAINT_SQL
$DEBIAN_MAINT_GRANT
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
if [ ! -s /root/pool_mysql_pass ]; then
  (umask 077; openssl rand -hex 32 >/root/pool_mysql_pass)
fi
chmod 600 /root/pool_mysql_pass
POOL_SQL_PASS="$(cat /root/pool_mysql_pass)"
if [[ ! "$POOL_SQL_PASS" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid pool database password file" >&2
  exit 1
fi
grep max_connections /etc/mysql/my.cnf || cat >>/etc/mysql/my.cnf <<'EOF'
[mysqld]
max_connections = 10000
EOF
systemctl restart mysql
if [[ -r /etc/mysql/debian.cnf ]]; then
  mysqladmin --defaults-file=/etc/mysql/debian.cnf ping >/dev/null
fi

su -l user -s /bin/bash <<EOF
set -e
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
POOL_SQL_PASS="$POOL_SQL_PASS" POOL_DEPLOY_PREPARE="$POOL_DEPLOY_PREPARE" node -e '
  const fs = require("fs");
  const exists = fs.existsSync("config.json");
  const config = JSON.parse(fs.readFileSync(exists ? "config.json" : "config_example.json", "utf8"));
  const prepare = process.env.POOL_DEPLOY_PREPARE === "1";
  if (!exists) {
    config.db_storage_path = "/home/user/pool_db/";
    config.mysql.password = process.env.POOL_SQL_PASS;
    fs.writeFileSync("config.json", JSON.stringify(config, null, 2) + "\n");
  } else if (!prepare) {
    config.mysql.password = process.env.POOL_SQL_PASS;
    fs.writeFileSync("config.json", JSON.stringify(config, null, 2) + "\n");
  }
'
pool_database_exists=1
if ! $USER_SQL_CMD -e "USE pool" >/dev/null 2>&1; then
  pool_database_exists=0
  $USER_SQL_CMD <deployment/base.sql
fi
if [ "$POOL_DEPLOY_PREPARE" != 1 ] || [ "$pool_database_exists" = 0 ]; then
$USER_SQL_CMD <<SQL
CREATE USER IF NOT EXISTS 'pool'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '$POOL_SQL_PASS';
CREATE USER IF NOT EXISTS 'pool'@'localhost' IDENTIFIED WITH mysql_native_password BY '$POOL_SQL_PASS';
ALTER USER 'pool'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '$POOL_SQL_PASS';
ALTER USER 'pool'@'localhost' IDENTIFIED WITH mysql_native_password BY '$POOL_SQL_PASS';
GRANT ALL ON pool.* TO 'pool'@'127.0.0.1';
GRANT ALL ON pool.* TO 'pool'@'localhost';
FLUSH PRIVILEGES;
SQL
$USER_SQL_CMD -e "INSERT IGNORE INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'authKey', '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)', 'string', 'Auth key sent with all Websocket frames for validation.')"
$USER_SQL_CMD -e "INSERT IGNORE INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'secKey', '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)', 'string', 'Secret key for signing miner email unsubscribe links.')"
if [ -f /home/user/wallets/wallet.address.txt ] && [ -f /home/user/wallets/wallet_fee.address.txt ]; then
  $USER_SQL_CMD -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet.address.txt)' WHERE module = 'pool' and item = 'address';"
$USER_SQL_CMD -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet_fee.address.txt)' WHERE module = 'payout' and item = 'feeAddress';"
fi
fi
if [ "$POOL_DEPLOY_PREPARE" != 1 ]; then
pm2 describe api >/dev/null 2>&1 || pm2 start init.js --name=api --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=api
pm2 describe monero-wallet-rpc >/dev/null 2>&1 || pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --daemon-address 127.0.0.1:18083 --rpc-bind-port 18082 --password-file /home/user/wallets/wallet_pass --wallet-file /home/user/wallets/wallet --trusted-daemon --disable-rpc-login
sleep 30
pm2 describe block_manager >/dev/null 2>&1 || pm2 start init.js --name=block_manager --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z"  -- --module=block_manager
pm2 describe worker >/dev/null 2>&1 || pm2 start init.js --name=worker --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --node-args="--max_old_space_size=8192" -- --module=worker
pm2 describe payments >/dev/null 2>&1 || pm2 start init.js --name=payments --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --no-autorestart -- --module=payments
pm2 describe remote_share >/dev/null 2>&1 || pm2 start init.js --name=remote_share --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=remote_share
pm2 describe long_runner >/dev/null 2>&1 || pm2 start init.js --name=long_runner --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=long_runner
fi
#pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
if [ "$POOL_DEPLOY_PREPARE" != 1 ]; then
  sleep 20
  pm2 describe pool_stats >/dev/null 2>&1 || pm2 start init.js --name=pool_stats --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool_stats
fi
if [ "$POOL_DEPLOY_PREPARE" != 1 ]; then pm2 save; fi
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

# The conntrack pressure guard is installed on public leaf nodes only.
# configure_pool_health_guard

if [ "$POOL_DEPLOY_PREPARE" = 1 ]; then
  systemctl start xtm
else
  systemctl start xtm xtm_mm
fi
wait_for_tari_sync

echo 'Frontend is installed in /home/user/mo-pool-ui and deployed to /var/www/mo-pool-ui. To rebuild it later, log in as "user" and run: cd ~/mo-pool-ui && npm ci && npm run build'
