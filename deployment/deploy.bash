#!/bin/bash -ex

NODEJS_VERSION="${NODEJS_VERSION:-v24.15.0}"
WWW_DNS="${WWW_DNS:-moneroocean.stream}"
API_DNS="${API_DNS:-api.moneroocean.stream}"
CF_DNS_API_TOKEN="${CF_DNS_API_TOKEN:-n/a}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-support@moneroocean.stream}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.3.0}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"
TARI_INSTALL_DIR="${TARI_INSTALL_DIR:-/usr/local/src/tari}"
TARI_COMPAT_DIR="${TARI_COMPAT_DIR:-/usr/local/src/xtm}"
TARI_CONFIG_PATCH_URL="${TARI_CONFIG_PATCH_URL:-https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh}"
TARI_EXTERNAL_IP="${TARI_EXTERNAL_IP:-}"
TARI_WALLET_PAYMENT_ADDRESS="${TARI_WALLET_PAYMENT_ADDRESS:-12FrDe5cUauXdMeCiG1DU3XQZdShjFd9A4p9agxsddVyAwpmz73x4b2Qdy5cPYaGmKNZ6g1fbCASJpPxnjubqjvHDa5}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this script as root"
  exit 1
fi
if [ "$#" -gt 0 ]; then
  echo "Please configure deploy.bash with environment variables: WWW_DNS, API_DNS, CF_DNS_API_TOKEN, CERTBOT_EMAIL"
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
  rm -rf "$TARI_COMPAT_DIR"
  ln -s "$TARI_INSTALL_DIR" "$TARI_COMPAT_DIR"
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

install -d -m 755 /etc/needrestart/conf.d
cat >/etc/needrestart/conf.d/moneroocean-critical.conf <<'EOF'
# Keep unattended package maintenance from restarting pool-critical services.
# Operators should restart these deliberately during a maintenance window.
$nrconf{override_rc}->{qr(^mysql\.service$)} = 0;
$nrconf{override_rc}->{qr(^pm2-user\.service$)} = 0;
$nrconf{override_rc}->{qr(^monero\.service$)} = 0;
$nrconf{override_rc}->{qr(^xtm\.service$)} = 0;
$nrconf{override_rc}->{qr(^xtm_mm\.service$)} = 0;
EOF

retry_command apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
if [ "${POOL_DEPLOY_TEST_MODE:-0}" = "1" ]; then
  echo "Skipping apt full-upgrade in test mode"
else
  retry_command apt-get -o Acquire::Retries=3 full-upgrade -y
fi
retry_command apt-get -o Acquire::Retries=3 install -y ca-certificates curl openssl sudo ufw nginx git vim unzip python3 g++ make libc-dev cmake libssl-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev mysql-server
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
for rule in ssh 443; do
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
  certbot certonly --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --dns-cloudflare --dns-cloudflare-propagation-seconds 30 --dns-cloudflare-credentials /root/dns_cloudflare_api_token.ini -d "$dns"
done
cat >/etc/nginx/sites-enabled/default <<EOF
server {
	listen 80;
	location /leafApi {
		proxy_pass http://localhost:8000;
		proxy_redirect off;
	}
	gzip on;
}

limit_req_zone \$uri zone=big_api:32m rate=30r/m;
server {
	listen 443 ssl;
	server_name $API_DNS;
	location /miner/ {
		limit_req zone=big_api burst=4;
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

	location / {
		try_files \$uri \$uri/ /index.html;
	}

        # The script-src hash allows mo-pool-ui's inline JSON-LD. If that block changes,
        # rebuild mo-pool-ui and recompute with: ./csp-hash.sh build/index.html
        add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'sha256-yENZ47wxlUnKLykemLwcnbrHwUk86i6YedHpk5ZL0Kk='; style-src 'self'; img-src 'self' data:; connect-src https://$API_DNS https://stats.uptimerobot.com; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests" always;
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
retry_command git clone https://github.com/monero-project/monero.git /usr/local/src/monero
cd /usr/local/src/monero
git checkout v0.18.4.6
retry_command git submodule update --init
USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release

(cat <<EOF
set -ex
mkdir -p ~/wallets
cd ~/wallets
echo pass >~/wallets/wallet_pass
echo 1 | /usr/local/src/monero/build/release/bin/monero-wallet-cli --offline --create-address-file --generate-new-wallet ~/wallets/wallet --password-file ~/wallets/wallet_pass --command address
echo 1 | /usr/local/src/monero/build/release/bin/monero-wallet-cli --offline --create-address-file --generate-new-wallet ~/wallets/wallet_fee --password-file ~/wallets/wallet_pass --command address
EOF
) | su user -l
echo; echo; echo
read -p "*** Write down your seeds for wallet and wallet_fee listed above and press ENTER to continue ***"

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
ExecStart=/bin/bash -c "(sleep 2; node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18146 18142) & (sleep 2; node /usr/local/src/grpc-json-proxy/grpc-json-proxy.js /usr/local/src/grpc-json-proxy/base_node.proto 18148 18142) & /usr/local/src/xtm/minotari_node --non-interactive-mode --watch status --disable-splash-screen"
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
ExecStart=/usr/local/src/xtm/minotari_merge_mining_proxy --non-interactive-mode
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
# install lmdb tools
( cd /home/user
  rm -rf node-lmdb
  retry_command git clone https://github.com/Venemo/node-lmdb.git
  cd node-lmdb
  git checkout c3135a3809da1d64ce1f0956b37b618711e33519
  cd dependencies/lmdb/libraries/liblmdb
  make -j $(nproc)
  mkdir -p /home/user/.bin
  echo >>/home/user/.bashrc
  echo 'export PATH=/home/user/.bin:$PATH' >>/home/user/.bashrc
  for i in mdb_copy mdb_dump mdb_load mdb_stat; do cp \$i /home/user/.bin/; done
)
mkdir -p /home/user/pool_db
sed -r 's#("db_storage_path": ).*#\1"/home/user/pool_db/",#' config_example.json >config.json
$USER_SQL_CMD <deployment/base.sql
$USER_SQL_CMD -e "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'authKey', '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)', 'string', 'Auth key sent with all Websocket frames for validation.')"
$USER_SQL_CMD -e "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'secKey', '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)', 'string', 'Secret key for signing miner email unsubscribe links.')"
$USER_SQL_CMD -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet.address.txt)' WHERE module = 'pool' and item = 'address';"
$USER_SQL_CMD -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet_fee.address.txt)' WHERE module = 'payout' and item = 'feeAddress';"
pm2 start init.js --name=api --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=api
pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --rpc-bind-port 18082 --password-file /home/user/wallets/wallet_pass --wallet-file /home/user/wallets/wallet --trusted-daemon --disable-rpc-login
sleep 30
pm2 start init.js --name=block_manager --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z"  -- --module=block_manager
pm2 start init.js --name=worker --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --node-args="--max_old_space_size=8192" -- --module=worker
pm2 start init.js --name=payments --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --no-autorestart -- --module=payments
pm2 start init.js --name=remote_share --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=remote_share
pm2 start init.js --name=long_runner --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=long_runner
#pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
sleep 20
pm2 start init.js --name=pool_stats --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool_stats
pm2 save
sudo env PATH=\$PATH:/home/user/.nvm/versions/node/\$NODEJS_VERSION/bin /home/user/.nvm/versions/node/\$NODEJS_VERSION/lib/node_modules/pm2/bin/pm2 startup systemd -u user --hp /home/user
cd /home/user
retry_command git clone https://github.com/MoneroOcean/mo-pool-ui.git
cd mo-pool-ui
retry_command npm install
retry_command npx playwright install --with-deps chromium
retry_command npm run build
EOF
) | su user -l

systemctl start xtm xtm_mm

echo 'Frontend is installed in /home/user/mo-pool-ui and deployed to /var/www/mo-pool-ui. To rebuild it later, log in as "user" and run: cd ~/mo-pool-ui && npm install && npm run build'
