#!/bin/bash
set -euo pipefail

cmd="$(basename "$0")"
tari_proxy_port="${POOL_DEPLOY_TARI_PROXY_PORT:-18081}"
monerod_port="${POOL_DEPLOY_MONEROD_PORT:-18083}"
minotari_node_port="${POOL_DEPLOY_MINOTARI_NODE_PORT:-18142}"
xtm_t_compat_port="${POOL_DEPLOY_XTM_T_COMPAT_PORT:-18146}"

write_fake_monero_repo() {
    local dest="$1"
    mkdir -p "$dest/build/release/bin" "$dest/src/rpc"
    printf 'fake\n' >"$dest/.codex-fake-monero"
    cat >"$dest/src/rpc/core_rpc_server.cpp" <<'EOF'
namespace
{
  void store_difficulty(cryptonote::difficulty_type difficulty, uint64_t &sdiff, std::string &swdiff, uint64_t &stop64)
  {
    store_128(difficulty, sdiff, swdiff, stop64);
  }
}

namespace cryptonote
{
  bool core_rpc_server::on_getblocktemplate(const COMMAND_RPC_GETBLOCKTEMPLATE::request& req, COMMAND_RPC_GETBLOCKTEMPLATE::response& res, epee::json_rpc::error& error_resp, const connection_context *ctx)
  {
    RPC_TRACKER(getblocktemplate);
    bool r;
    if (use_bootstrap_daemon_if_necessary<COMMAND_RPC_GETBLOCKTEMPLATE>(invoke_http_mode::JON_RPC, "getblocktemplate", req, res, r))
      return r;

    if(!check_core_ready())
    {
      error_resp.code = CORE_RPC_ERROR_CODE_CORE_BUSY;
      error_resp.message = "Core is busy";
      return false;
    }

    if(req.reserve_size > 255)
    {
      error_resp.code = CORE_RPC_ERROR_CODE_TOO_BIG_RESERVE_SIZE;
      error_resp.message = "Too big reserved size, maximum 255";
      return false;
    }

    if(req.reserve_size && !req.extra_nonce.empty())
    {
      error_resp.code = CORE_RPC_ERROR_CODE_WRONG_PARAM;
      error_resp.message = "Cannot specify both a reserve_size and an extra_nonce";
      return false;
    }

    if(req.extra_nonce.size() > 510)
    {
      error_resp.code = CORE_RPC_ERROR_CODE_TOO_BIG_RESERVE_SIZE;
      error_resp.message = "Too big extra_nonce size, maximum 510 hex chars";
      return false;
    }

    cryptonote::address_parse_info info;
    block b;
    cryptonote::blobdata blob_reserve;
    size_t reserved_offset;
    if(!req.extra_nonce.empty())
    {
      if(!string_tools::parse_hexstr_to_binbuff(req.extra_nonce, blob_reserve))
      {
        error_resp.code = CORE_RPC_ERROR_CODE_WRONG_PARAM;
        error_resp.message = "Parameter extra_nonce should be a hex string";
        return false;
      }
    }
    else
      blob_reserve.resize(req.reserve_size, 0);
    cryptonote::difficulty_type wdiff;
    crypto::hash prev_block;
    return true;
  }
}
EOF
    cat >"$dest/Makefile" <<'EOF'
.PHONY: release
release:
	@mkdir -p build/release/bin
	@ln -sf /workspace/repo/tests/deploy/common/fake_monerod.js build/release/bin/monerod
	@ln -sf /workspace/repo/tests/deploy/common/fake_monerod.js build/release/bin/monero-wallet-cli
	@ln -sf /workspace/repo/tests/deploy/common/fake_monerod.js build/release/bin/monero-wallet-rpc
EOF
    for bin in monerod monero-wallet-cli monero-wallet-rpc; do
        ln -sf /workspace/repo/tests/deploy/common/fake_monerod.js "$dest/build/release/bin/$bin"
    done
    /usr/bin/git -C "$dest" init -q
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

write_fake_tari_zip() {
    local dest="$1"
    OUT="$dest" /usr/bin/node <<'NODE'
const fs = require("node:fs");

const configToml = String.raw`[base_node]
grpc_enabled = false
grpc_address = "/ip4/127.0.0.1/tcp/18142"
grpc_server_allow_methods = [
  # "GetTipInfo",
  # "GetHeaderByHash",
  # "GetBlocks",
  # "GetNewBlockTemplateWithCoinbases",
  # "SubmitBlock",
]
use_libtor = true

[base_node.storage]
pruning_horizon = 0
pruning_interval = 0

[base_node.p2p]
public_addresses = []

[base_node.p2p.transport]
type = "tor"
tcp.listener_address = "/ip4/127.0.0.1/tcp/18189"

[wallet]
grpc_enabled = false
grpc_address = "/ip4/127.0.0.1/tcp/18143"
use_libtor = true

[merge_mining_proxy]
use_dynamic_fail_data = true
base_node_grpc_address = "http://127.0.0.1:18142"
listener_address = "/ip4/127.0.0.1/tcp/18081"
submit_to_origin = true
wallet_payment_address = ""
`;
const minotariNode = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--init" ]; then
    config_dir="\${HOME:-/home/monerodaemon}/.tari/mainnet/config"
    mkdir -p "$config_dir"
    cat >"$config_dir/config.toml" <<'CONFIG'
${configToml}CONFIG
    exit 0
  fi
done
sleep 3600
`;
const entries = {
    minotari_node: minotariNode,
    minotari_merge_mining_proxy: "#!/bin/sh\nsleep 3600\n"
};

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
}
function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }

const localParts = [];
const centralParts = [];
let offset = 0;
for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
        u32(data.length), u32(data.length), u16(nameBuffer.length), u16(0), nameBuffer, data
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
        u32(0x02014b50), u16(0x031e), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
        u32(data.length), u32(data.length), u16(nameBuffer.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), nameBuffer
    ]));
    offset += local.length;
}
const central = Buffer.concat(centralParts);
const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centralParts.length), u16(centralParts.length),
    u32(central.length), u32(offset), u16(0)
]);
fs.writeFileSync(process.env.OUT, Buffer.concat([...localParts, central, end]));
NODE
}

case "$cmd" in
    wget)
        url=""
        for arg in "$@"; do
            case "$arg" in
                http://*|https://*) url="$arg" ;;
            esac
        done
        exec /usr/bin/wget "$@"
        ;;
    curl)
        original_args=("$@")
        output=""
        url=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -o)
                    output="${2:-}"
                    shift 2
                    ;;
                http://*|https://*|file://*)
                    url="$1"
                    shift
                    ;;
                *)
                    shift
                    ;;
            esac
        done
        if [[ "$url" == https://github.com/tari-project/tari/releases/download/*/tari_suite-*-linux-*.zip ]]; then
            test -n "$output" || { echo "fake Tari curl requires -o" >&2; exit 1; }
            write_fake_tari_zip "$output"
            exit 0
        fi
        if [[ "$url" == https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/patch-tari-config.sh ]]; then
            test -n "$output" || { echo "fake patch curl requires -o" >&2; exit 1; }
            cp /workspace/repo/deployment/patch-tari-config.sh "$output"
            exit 0
        fi
        if [[ "$url" == https://api.ipify.org ]]; then
            printf '127.0.0.1'
            exit 0
        fi
        exec /usr/bin/curl "${original_args[@]}"
        ;;
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
    setcap|ufw|service)
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
