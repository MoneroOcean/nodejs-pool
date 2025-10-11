#!/bin/bash -x

NODEJS_VERSION=v20.12.2

WWW_DNS=$1
API_DNS=$2
CF_DNS_API_TOKEN=$3
CERTBOT_EMAIL=$4

test -z $WWW_DNS && WWW_DNS="moneroocean.stream"
test -z $API_DNS && API_DNS="api.moneroocean.stream"
test -z $CF_DNS_API_TOKEN && CF_DNS_API_TOKEN="n/a"
test -z $CERTBOT_EMAIL && CERTBOT_EMAIL="support@moneroocean.stream"

if [[ $(whoami) != "root" ]]; then
  echo "Please run this script as root"
  exit 1
fi

DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
timedatectl set-timezone Etc/UTC

adduser --disabled-password --gecos "" user
grep -q "user ALL=(ALL) NOPASSWD:ALL" /etc/sudoers || echo "user ALL=(ALL) NOPASSWD:ALL" >>/etc/sudoers
su user -c "mkdir /home/user/.ssh"
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
ufw allow ssh
ufw allow 443
ufw --force enable

cat >/root/.vimrc <<'EOF'
colorscheme desert
set fo-=ro
EOF

cat >/home/user/.vimrc <<'EOF'
colorscheme desert
set fo-=ro
EOF
chown user:user /home/user/.vimrc

DEBIAN_FRONTEND=noninteractive apt-get install -y nginx ntp sudo
snap install --classic certbot
snap set certbot trust-plugin-with-root=ok
snap install certbot-dns-cloudflare
find /snap/certbot -name options-ssl-nginx.conf | xargs -I{} cp {} /etc/letsencrypt/options-ssl-nginx.conf
echo "dns_cloudflare_api_token=$CF_DNS_API_TOKEN" >/root/dns_cloudflare_api_token.ini
chmod 600 /root/dns_cloudflare_api_token.ini
certbot certonly --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --dns-cloudflare --dns-cloudflare-propagation-seconds 30 --dns-cloudflare-credentials /root/dns_cloudflare_api_token.ini -d $WWW_DNS
certbot certonly --non-interactive --agree-tos --email "$CERTBOT_EMAIL" --dns-cloudflare --dns-cloudflare-propagation-seconds 30 --dns-cloudflare-credentials /root/dns_cloudflare_api_token.ini -d $API_DNS
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
		return 301 https://$host$request_uri;
	}
}

server {
	listen 443 ssl;
	server_name $WWW_DNS;
	root /var/www/mo/;
        index index.html;
	gzip on;
        add_header Content-Security-Policy "default-src 'none'; connect-src https://api.moneroocean.stream; font-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
	ssl_certificate /etc/letsencrypt/live/$WWW_DNS/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/$WWW_DNS/privkey.pem;
	include /etc/letsencrypt/options-ssl-nginx.conf;
	# Redirect non-https traffic to https
	if (\$scheme != "https") {
		return 301 https://;
	}
}
EOF
chown -R www-data:www-data /var/www
chmod g+s /var/www
systemctl daemon-reload
systemctl restart nginx

DEBIAN_FRONTEND=noninteractive apt-get install -y git make g++ cmake libssl-dev libunbound-dev libboost-dev libboost-system-dev libboost-date-time-dev libboost-dev libboost-system-dev libboost-date-time-dev libboost-filesystem-dev libboost-thread-dev libboost-chrono-dev libboost-locale-dev libboost-regex-dev libboost-regex-dev libboost-program-options-dev libzmq3-dev
cd /usr/local/src
git clone https://github.com/monero-project/monero.git
cd monero
git checkout v0.18.4.3
git submodule update --init
USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release

(cat <<EOF
set -x
mkdir ~/wallets
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
ExecStart=/usr/local/src/monero/build/release/bin/monerod --hide-my-port --prune-blockchain --enable-dns-blocklist --no-zmq --out-peers 64 --non-interactive --restricted-rpc --block-notify '/bin/bash /home/user/nodejs-pool/block_notify.sh'
Restart=always
User=monerodaemon
Nice=10
CPUQuota=400%

[Install]
WantedBy=multi-user.target
EOF

useradd -m monerodaemon -d /home/monerodaemon
systemctl daemon-reload
systemctl enable monero
systemctl start monero

sleep 30
echo "Please wait until Monero daemon is fully synced"
tail -f /home/monerodaemon/.bitmonero/bitmonero.log 2>/dev/null | grep Synced &
( tail -F -n0 /home/monerodaemon/.bitmonero/bitmonero.log & ) | egrep -q "You are now synchronized with the network"
killall tail 2>/dev/null
echo "Monero daemon is synced"

DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
ROOT_SQL_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
(cat <<EOF
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '$ROOT_SQL_PASS';
FLUSH PRIVILEGES;
EOF
) | (test -f /root/mysql_pass && mysql -u root --password=$(cat /root/mysql_pass) || mysql -u root)
echo $ROOT_SQL_PASS >/root/mysql_pass
chmod 600 /root/mysql_pass
grep max_connections /etc/mysql/my.cnf || cat >>/etc/mysql/my.cnf <<'EOF'
[mysqld]
max_connections = 10000
EOF
systemctl restart mysql

(cat <<EOF
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.0/install.sh | bash
source /home/user/.nvm/nvm.sh
nvm install $NODEJS_VERSION
nvm alias default $NODEJS_VERSION
test -f /usr/bin/node || sudo ln -s \$(which node) /usr/bin/node
set -x
git clone https://github.com/MoneroOcean/nodejs-pool.git
cd /home/user/nodejs-pool
JOBS=$(nproc) npm install
# install lmdb tools
( cd /home/user
  rm -rf node-lmdb
  git clone https://github.com/Venemo/node-lmdb.git
  cd node-lmdb
  git checkout c3135a3809da1d64ce1f0956b37b618711e33519
  cd dependencies/lmdb/libraries/liblmdb
  make -j $(nproc)
  mkdir /home/user/.bin
  echo >>/home/user/.bashrc
  echo 'export PATH=/home/user/.bin:$PATH' >>/home/user/.bashrc
  for i in mdb_copy mdb_dump mdb_load mdb_stat; do cp \$i /home/user/.bin/; done
)
npm install -g pm2
pm2 install pm2-logrotate
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
mkdir /home/user/pool_db
sed -r 's#("db_storage_path": ).*#\1"/home/user/pool_db/",#' config_example.json >config.json
mysql -u root --password=$ROOT_SQL_PASS <deployment/base.sql
mysql -u root --password=$ROOT_SQL_PASS -e "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'authKey', '`cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1`', 'string', 'Auth key sent with all Websocket frames for validation.')"
mysql -u root --password=$ROOT_SQL_PASS -e "INSERT INTO pool.config (module, item, item_value, item_type, Item_desc) VALUES ('api', 'secKey', '`cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1`', 'string', 'HMAC key for Passwords.  JWT Secret Key.  Changing this will invalidate all current logins.')"
mysql -u root --password=$ROOT_SQL_PASS -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet.address.txt)' WHERE module = 'pool' and item = 'address';"
mysql -u root --password=$ROOT_SQL_PASS -e "UPDATE pool.config SET item_value = '$(cat /home/user/wallets/wallet_fee.address.txt)' WHERE module = 'payout' and item = 'feeAddress';"
pm2 start init.js --name=api --log-date-format="YYYY-MM-DD HH:mm Z" -- --module=api
pm2 start /usr/local/src/monero/build/release/bin/monero-wallet-rpc -- --rpc-bind-port 18082 --password-file /home/user/wallets/wallet_pass --wallet-file /home/user/wallets/wallet --trusted-daemon --disable-rpc-login
sleep 30
pm2 start init.js --name=blockManager --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z"  -- --module=blockManager
pm2 start init.js --name=worker --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --node-args="--max_old_space_size=8192" -- --module=worker
pm2 start init.js --name=payments --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" --no-autorestart -- --module=payments
pm2 start init.js --name=remoteShare --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=remoteShare
pm2 start init.js --name=longRunner --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=longRunner
#pm2 start init.js --name=pool --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
sleep 20
pm2 start init.js --name=pool_stats --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool_stats
pm2 save
sudo env PATH=$PATH:/home/user/.nvm/versions/node/$NODEJS_VERSION/bin /home/user/.nvm/versions/node/$NODEJS_VERSION/lib/node_modules/pm2/bin/pm2 startup systemd -u user --hp /home/user
cd /home/user
git clone https://github.com/MoneroOcean/moneroocean-gui.git
cd moneroocean-gui
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser
sudo snap install chromium
npm install -g uglifycss uglify-js html-minifier
npm install -D critical@latest
EOF
) | su user -l

echo 'Now logout server, loging again under "user" account and run ~/moneroocean-gui/build.sh to build web site'
