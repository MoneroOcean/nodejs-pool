#!/bin/bash -x

NODEJS_VERSION=v20.12.2

if [[ $(whoami) != "root" ]]; then
  echo "Please run this script as root"
  exit 1
fi

DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ntp sudo ufw
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
  sed -i 's/#\?  .\+/PermitEmptyPasswords no/g' /etc/ssh/sshd_config
  service ssh restart
fi

ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 3333
ufw allow 5555
ufw allow 7777
ufw allow 9000
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

DEBIAN_FRONTEND=noninteractive apt-get install -y vim git make g++ cmake libssl-dev libunbound-dev libboost-dev libboost-system-dev libboost-date-time-dev libboost-dev libboost-system-dev libboost-date-time-dev libboost-filesystem-dev libboost-thread-dev libboost-chrono-dev libboost-locale-dev libboost-regex-dev libboost-regex-dev libboost-program-options-dev libzmq3-dev
cd /usr/local/src
git clone https://github.com/monero-project/monero.git
cd monero
git checkout v0.18.4.3
git submodule update --init
USE_SINGLE_BUILDDIR=1 make -j$(nproc) release || USE_SINGLE_BUILDDIR=1 make -j1 release

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
npm install -g pm2
pm2 install pm2-logrotate
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.pool" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
#pm2 start init.js --name=pool --kill-timeout 10000 --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
EOF
) | su user -l
