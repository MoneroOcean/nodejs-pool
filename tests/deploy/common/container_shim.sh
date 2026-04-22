#!/bin/bash
set -euo pipefail

cmd="$(basename "$0")"
tari_proxy_port="${POOL_DEPLOY_TARI_PROXY_PORT:-18081}"
monerod_port="${POOL_DEPLOY_MONEROD_PORT:-18083}"
minotari_node_port="${POOL_DEPLOY_MINOTARI_NODE_PORT:-18142}"
xtm_t_compat_port="${POOL_DEPLOY_XTM_T_COMPAT_PORT:-18146}"

write_fake_monero_repo() {
    local dest="$1"
    mkdir -p "$dest/build/release/bin"
    printf 'fake\n' >"$dest/.codex-fake-monero"
    cat >"$dest/Makefile" <<'EOF'
.PHONY: release
release:
	@true
EOF
    for bin in monerod monero-wallet-cli monero-wallet-rpc; do
        ln -sf /workspace/repo/tests/deploy/common/fake_monerod.js "$dest/build/release/bin/$bin"
    done
}

start_fake_chain() {
    local role="$1"
    local port="$2"
    local log_path="${3:-}"
    local args=(--role "$role" --port "$port")
    if [[ -n "$log_path" ]]; then
        args+=(--log-path "$log_path")
    fi
    nohup /usr/bin/node /workspace/repo/tests/deploy/common/fake_monerod.js "${args[@]}" >"/tmp/codex-${role}.log" 2>&1 &
}

case "$cmd" in
    git)
        if [[ "${1:-}" == "clone" ]]; then
            url="${2:-}"
            dest="${3:-$(basename "${url%.git}")}"
            case "$url" in
                https://github.com/MoneroOcean/nodejs-pool.git)
                    mkdir -p "$dest"
                    tar --exclude=.git --exclude=.cache --exclude=node_modules --exclude=test-artifacts -C /workspace/repo -cf - . | tar -C "$dest" -xf -
                    exit 0
                    ;;
                https://github.com/monero-project/monero.git)
                    write_fake_monero_repo "$dest"
                    exit 0
                    ;;
            esac
        fi
        if [[ -f .codex-fake-monero && ( "${1:-}" == "checkout" || "${1:-}" == "submodule" ) ]]; then
            exit 0
        fi
        exec /usr/bin/git "$@"
        ;;
    systemctl)
        case "${1:-}:${2:-}" in
            daemon-reload:*|enable:monero)
                exit 0
                ;;
            start:monero)
                mkdir -p /home/monerodaemon/.bitmonero
                : > /home/monerodaemon/.bitmonero/bitmonero.log
                chown -R monerodaemon:monerodaemon /home/monerodaemon
                start_fake_chain tari-proxy "$tari_proxy_port" /home/monerodaemon/.bitmonero/bitmonero.log
                start_fake_chain monerod "$monerod_port"
                start_fake_chain minotari-node "$minotari_node_port"
                nohup socat TCP-LISTEN:"$xtm_t_compat_port",bind=127.0.0.1,reuseaddr,fork TCP:127.0.0.1:"$minotari_node_port" >/tmp/codex-minotari-compat.log 2>&1 &
                exit 0
                ;;
            restart:nginx)
                if command -v nginx >/dev/null 2>&1; then
                    nginx -t
                    pgrep nginx >/dev/null 2>&1 && nginx -s reload || nginx
                fi
                exit 0
                ;;
            restart:mysql)
                getent group mysql >/dev/null 2>&1 || groupadd --system mysql
                id -u mysql >/dev/null 2>&1 || useradd --system --gid mysql --home-dir /nonexistent --shell /usr/sbin/nologin mysql
                install -d -o mysql -g mysql /var/lib/mysql
                install -d -o mysql -g mysql /run/mysqld
                if [[ ! -d /var/lib/mysql/mysql ]] && command -v mysqld >/dev/null 2>&1; then
                    mysqld --initialize-insecure --user=mysql --datadir=/var/lib/mysql >/tmp/codex-mysqld-init.log 2>&1
                fi
                if ! pgrep -x mysqld >/dev/null 2>&1; then
                    if command -v mysqld_safe >/dev/null 2>&1; then
                        nohup mysqld_safe --skip-networking=0 --bind-address=127.0.0.1 >/tmp/codex-mysqld.log 2>&1 &
                    else
                        nohup mysqld --user=mysql --datadir=/var/lib/mysql --socket=/run/mysqld/mysqld.sock --pid-file=/run/mysqld/mysqld.pid --skip-networking=0 --bind-address=127.0.0.1 --daemonize --log-error=/tmp/codex-mysqld.log >/tmp/codex-mysqld-launch.log 2>&1 &
                    fi
                fi
                for _ in $(seq 1 40); do
                    mysqladmin ping >/dev/null 2>&1 && exit 0
                    sleep 1
                done
                cat /tmp/codex-mysqld.log >&2 || true
                exit 1
                ;;
        esac
        exit 0
        ;;
    timedatectl)
        if [[ "${1:-}" == "set-timezone" && -n "${2:-}" ]]; then
            ln -snf "/usr/share/zoneinfo/${2}" /etc/localtime 2>/dev/null || true
            printf '%s\n' "${2}" >/etc/timezone
        fi
        exit 0
        ;;
    ufw|service)
        exit 0
        ;;
    certbot)
        domain=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -d|--domains) domain="$2"; shift 2 ;;
                -d=*) domain="${1#*=}"; shift ;;
                *) shift ;;
            esac
        done
        test -n "$domain" || domain="localhost"
        mkdir -p "/etc/letsencrypt/live/$domain"
        openssl req -subj "/CN=$domain" -newkey rsa:2048 -nodes -keyout "/etc/letsencrypt/live/$domain/privkey.pem" -x509 -out "/etc/letsencrypt/live/$domain/fullchain.pem" -days 36500 >/dev/null 2>&1
        exit 0
        ;;
esac

echo "Unsupported shim invocation: $cmd" >&2
exit 1
