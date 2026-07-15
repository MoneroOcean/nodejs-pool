#!/usr/bin/env bash
set -euo pipefail

# Patch a stock Tari 5.4 mainnet config.toml for MoneroOcean-style XTM use.
#
# This script modifies only these settings:
# - [base_node]
#   - grpc_enabled = true
#   - grpc_address = "/ip4/<--grpc-bind>/tcp/18142"
#   - uncomment every method already present in grpc_server_allow_methods
#   - use_libtor = false
# - [base_node.storage]
#   - pruning_horizon = 10000
#   - pruning_interval = 50
# - [base_node.p2p]
#   - public_addresses = ["/ip4/<external IPv4>/tcp/18189",]
# - [base_node.p2p.transport]
#   - type = "tcp"
#   - tcp.listener_address = "/ip4/0.0.0.0/tcp/18189"
# - [wallet]
#   - grpc_enabled = true
#   - grpc_address = "/ip4/127.0.0.1/tcp/18143"
#   - use_libtor = false
# - [merge_mining_proxy]
#   - use_dynamic_fail_data = false
#   - monerod_url = [ "<--monerod-url>" ]
#   - base_node_grpc_address = "<--base-node-grpc-address>"
#   - listener_address = "/ip4/127.0.0.1/tcp/18081"
#   - submit_to_origin = false
#   - wallet_payment_address = "<--wallet-payment-address>"
#
# It fails instead of guessing if required sections or keys are missing or
# ambiguous. By default it writes a timestamped backup next to the config.

DEFAULT_WALLET_PAYMENT_ADDRESS="12FrDe5cUauXdMeCiG1DU3XQZdShjFd9A4p9agxsddVyAwpmz73x4b2Qdy5cPYaGmKNZ6g1fbCASJpPxnjubqjvHDa5"

usage() {
  cat <<'USAGE'
Usage:
  scripts/patch-tari-config.sh <config.toml> [options]

Options:
  --grpc-bind <127.0.0.1|0.0.0.0>
      Address for base_node.grpc_address. Default: 127.0.0.1

  --external-ip <ipv4>
      Public IPv4 for base_node.p2p.public_addresses. If omitted, the script
      tries to detect it and prints the selected address to stdout.

  --wallet-payment-address <address>
      Tari wallet payment address for merge_mining_proxy.wallet_payment_address.
      Defaults to the MoneroOcean XTM address in this script.

  --pruning-horizon <blocks>
      Number of recent Tari blocks to retain in full. Default: 10000

  --pruning-interval <blocks>
      Number of blocks between pruning passes. Default: 50

  --monerod-url <url>
      Monerod URL for merge_mining_proxy.monerod_url.
      Default: http://localhost:18083

  --base-node-grpc-address <url>
      Base node gRPC URL for merge_mining_proxy.base_node_grpc_address.
      Default: http://127.0.0.1:18142

  --base-node-grpc-ip <ipv4>
      Convenience form for --base-node-grpc-address http://<ipv4>:18142.

  --dry-run
      Validate and print the patched config to stdout without changing files.

  --no-backup
      Do not create <config.toml>.bak.<timestamp> before writing.

  -h, --help
      Show this help.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

is_ipv4() {
  python3 - "$1" <<'PY'
import ipaddress
import sys
try:
    ipaddress.IPv4Address(sys.argv[1])
except ValueError:
    sys.exit(1)
PY
}

detect_external_ipv4() {
  local ip=""
  if command -v curl >/dev/null 2>&1; then
    ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    [ -n "$ip" ] && is_ipv4 "$ip" && printf '%s\n' "$ip" && return 0
  fi

  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '
    $1 !~ /^127\./ &&
    $1 !~ /^10\./ &&
    $1 !~ /^192\.168\./ &&
    $1 !~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./ &&
    $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print; exit }
  ')"
  [ -n "$ip" ] && is_ipv4 "$ip" && printf '%s\n' "$ip" && return 0
  return 1
}

config_path=""
grpc_bind="127.0.0.1"
external_ip=""
wallet_payment_address="$DEFAULT_WALLET_PAYMENT_ADDRESS"
pruning_horizon="10000"
pruning_interval="50"
monerod_url="http://localhost:18083"
base_node_grpc_address="http://127.0.0.1:18142"
dry_run=0
backup=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --grpc-bind) [ "$#" -ge 2 ] || die "--grpc-bind requires a value"; grpc_bind="$2"; shift 2 ;;
    --external-ip) [ "$#" -ge 2 ] || die "--external-ip requires a value"; external_ip="$2"; shift 2 ;;
    --wallet-payment-address) [ "$#" -ge 2 ] || die "--wallet-payment-address requires a value"; wallet_payment_address="$2"; shift 2 ;;
    --pruning-horizon) [ "$#" -ge 2 ] || die "--pruning-horizon requires a value"; pruning_horizon="$2"; shift 2 ;;
    --pruning-interval) [ "$#" -ge 2 ] || die "--pruning-interval requires a value"; pruning_interval="$2"; shift 2 ;;
    --monerod-url) [ "$#" -ge 2 ] || die "--monerod-url requires a value"; monerod_url="$2"; shift 2 ;;
    --base-node-grpc-address) [ "$#" -ge 2 ] || die "--base-node-grpc-address requires a value"; base_node_grpc_address="$2"; shift 2 ;;
    --base-node-grpc-ip)
      [ "$#" -ge 2 ] || die "--base-node-grpc-ip requires a value"
      is_ipv4 "$2" || die "invalid --base-node-grpc-ip IPv4: $2"
      base_node_grpc_address="http://$2:18142"
      shift 2
      ;;
    --dry-run) dry_run=1; shift ;;
    --no-backup) backup=0; shift ;;
    --*) die "unknown option: $1" ;;
    *)
      [ -z "$config_path" ] || die "unexpected extra argument: $1"
      config_path="$1"
      shift
      ;;
  esac
done

[ -n "$config_path" ] || die "missing config.toml path"
[ -f "$config_path" ] || die "config not found: $config_path"
[ "$grpc_bind" = "127.0.0.1" ] || [ "$grpc_bind" = "0.0.0.0" ] || die "--grpc-bind must be 127.0.0.1 or 0.0.0.0"
[[ "$pruning_horizon" =~ ^[0-9]+$ ]] || die "--pruning-horizon must be a non-negative integer"
[[ "$pruning_interval" =~ ^[1-9][0-9]*$ ]] || die "--pruning-interval must be a positive integer"
case "$base_node_grpc_address" in
  http://*:*|https://*:*) ;;
  *) die "--base-node-grpc-address must include scheme, host, and port, e.g. http://127.0.0.1:18142" ;;
esac

if [ -z "$external_ip" ]; then
  external_ip="$(detect_external_ipv4)" || die "could not detect external IPv4; pass --external-ip <ipv4>"
fi
is_ipv4 "$external_ip" || die "invalid external IPv4: $external_ip"
echo "external_ipv4=$external_ip"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

python3 - "$config_path" "$tmp" "$grpc_bind" "$external_ip" "$wallet_payment_address" "$pruning_horizon" "$pruning_interval" "$monerod_url" "$base_node_grpc_address" <<'PY'
import re
import sys
from pathlib import Path

src, dst, grpc_bind, external_ip, wallet_payment_address, pruning_horizon, pruning_interval, monerod_url, base_node_grpc_address = sys.argv[1:]
lines = Path(src).read_text().splitlines(keepends=True)

section_re = re.compile(r"^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$")
sections = {m.group(1): i for i, line in enumerate(lines) if (m := section_re.match(line))}
required = {"base_node", "base_node.storage", "base_node.p2p", "base_node.p2p.transport", "wallet", "merge_mining_proxy"}
missing = sorted(required - set(sections))
if missing:
    raise SystemExit(f"missing required section(s): {', '.join(missing)}")

def bounds(section):
    start = sections[section] + 1
    end = min([i for i in sections.values() if i > sections[section]] or [len(lines)])
    return start, end

def key_lines(section, key, active_only=False):
    start, end = bounds(section)
    prefix = "" if active_only else "#?"
    rx = re.compile(rf"^\s*{prefix}\s*{re.escape(key)}\s*=")
    return [i for i in range(start, end) if rx.match(lines[i])]

def find_key(section, key):
    matches = key_lines(section, key)
    active = [i for i in matches if not lines[i].lstrip().startswith("#")]
    if len(active) > 1:
        raise SystemExit(f"multiple active {section}.{key} entries")
    if len(active) == 1:
        return active[0]
    if len(matches) > 1:
        raise SystemExit(f"multiple commented {section}.{key} entries; refusing ambiguous replacement")
    return matches[0] if matches else None

def set_value(section, key, value):
    idx = find_key(section, key)
    if idx is None:
        raise SystemExit(f"could not find {section}.{key}; refusing to insert unknown layout")
    indent = re.match(r"^(\s*)", lines[idx]).group(1)
    lines[idx] = f"{indent}{key} = {value}\n"

def insert_or_set_after(section, key, value, anchor_key):
    active = key_lines(section, key, active_only=True)
    if len(active) > 1:
        raise SystemExit(f"multiple active {section}.{key} entries")
    if len(active) == 1:
        set_value(section, key, value)
        return
    anchor = find_key(section, anchor_key)
    if anchor is None:
        raise SystemExit(f"could not find insertion anchor {section}.{anchor_key}")
    lines.insert(anchor + 1, f"{key} = {value}\n")
    rebuild_sections()

def rebuild_sections():
    sections.clear()
    sections.update({m.group(1): i for i, line in enumerate(lines) if (m := section_re.match(line))})

def uncomment_list_entries(section, key):
    idx = find_key(section, key)
    if idx is None:
        raise SystemExit(f"could not find {section}.{key}; refusing to insert unknown layout")
    end = idx
    while end < len(lines) and "]" not in lines[end]:
        end += 1
    if end >= len(lines):
        raise SystemExit(f"unterminated list for {section}.{key}")

    value_rx = re.compile(r'^(\s*)#\s*("[A-Za-z0-9_]+",?\s*(?:#.*)?\n?)$')
    for i in range(idx + 1, end):
        if m := value_rx.match(lines[i]):
            lines[i] = f"{m.group(1)}{m.group(2)}"

    active_values = [line for line in lines[idx + 1:end] if re.match(r'^\s*"[A-Za-z0-9_]+",?\s*(?:#.*)?$', line)]
    if not active_values:
        raise SystemExit(f"found {section}.{key} but no method entries could be uncommented")

set_value("base_node", "grpc_enabled", "true")
set_value("base_node", "grpc_address", f'"/ip4/{grpc_bind}/tcp/18142"')
uncomment_list_entries("base_node", "grpc_server_allow_methods")
set_value("base_node", "use_libtor", "false")

set_value("base_node.storage", "pruning_horizon", pruning_horizon)
set_value("base_node.storage", "pruning_interval", pruning_interval)

set_value("base_node.p2p", "public_addresses", f'["/ip4/{external_ip}/tcp/18189",]')
set_value("base_node.p2p.transport", "type", '"tcp"')
set_value("base_node.p2p.transport", "tcp.listener_address", '"/ip4/0.0.0.0/tcp/18189"')

set_value("wallet", "grpc_enabled", "true")
set_value("wallet", "grpc_address", '"/ip4/127.0.0.1/tcp/18143"')
set_value("wallet", "use_libtor", "false")

set_value("merge_mining_proxy", "use_dynamic_fail_data", "false")
insert_or_set_after("merge_mining_proxy", "monerod_url", f'[ "{monerod_url}" ]', "use_dynamic_fail_data")
set_value("merge_mining_proxy", "base_node_grpc_address", f'"{base_node_grpc_address}"')
set_value("merge_mining_proxy", "listener_address", '"/ip4/127.0.0.1/tcp/18081"')
set_value("merge_mining_proxy", "submit_to_origin", "false")
set_value("merge_mining_proxy", "wallet_payment_address", f'"{wallet_payment_address}"')

Path(dst).write_text("".join(lines))
PY

if [ "$dry_run" -eq 1 ]; then
  cat "$tmp"
  exit 0
fi

if cmp -s "$config_path" "$tmp"; then
  echo "no changes needed: $config_path" >&2
  exit 0
fi

if [ "$backup" -eq 1 ]; then
  backup_path="${config_path}.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$config_path" "$backup_path"
  echo "backup=$backup_path" >&2
fi

cat "$tmp" > "$config_path"
echo "patched=$config_path" >&2
