#!/usr/bin/env bash
set -euo pipefail

dry_run=0
reason=""
port=""
xmr_height=""
expected_xmr_height=""
xtm_height=""
expected_xtm_height=""
lock_file="${FIX_DAEMON_LOCK:-/tmp/fix_daemon.lock}"
monerod_rpc_url="http://127.0.0.1:18083/json_rpc"
monerod_get_info_payload='{"jsonrpc":"2.0","id":"0","method":"get_info"}'
monerod_direct_height=""

usage() {
  cat <<'EOF'
Usage: fix_daemon.sh [--dry-run] <reason> [options]

Reasons:
  xmr-lag             restart monerod, relay-pool if present, and xtm_mm if present
  proxy-unhealthy     restart monerod, relay-pool if present, and xtm_mm if present
  xtm-lag             restart local xtm if present/enabled, relay-pool if present, and xtm_mm if present
  template-stuck      restart monerod, local xtm if present/enabled, relay-pool if present, and xtm_mm if present

Options:
  --port <port>
  --xmr-height <height>
  --expected-xmr-height <height>
  --xtm-height <height>
  --expected-xtm-height <height>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --port)
      port="${2:-}"
      shift 2
      ;;
    --xmr-height)
      xmr_height="${2:-}"
      shift 2
      ;;
    --expected-xmr-height)
      expected_xmr_height="${2:-}"
      shift 2
      ;;
    --xtm-height)
      xtm_height="${2:-}"
      shift 2
      ;;
    --expected-xtm-height)
      expected_xtm_height="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -z "$reason" ]; then
        if [[ "$1" =~ ^[0-9]+$ ]]; then
          reason="template-stuck"
          port="$1"
        else
          reason="$1"
        fi
        shift
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

reason="${reason:-template-stuck}"

exec 9>"$lock_file"
if ! flock -n 9; then
  logger -t fix_daemon "skipping $reason recovery because another fix is running" 2>/dev/null || true
  echo "fix_daemon: another recovery is already running"
  exit 0
fi

log() {
  logger -t fix_daemon "$*" 2>/dev/null || true
  echo "fix_daemon: $*"
}

systemctl_cmd() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
  else
    sudo -n systemctl "$@"
  fi
}

service_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

service_enabled() {
  systemctl is-enabled "$1" >/dev/null 2>&1
}

run_service() {
  local action="$1"
  local unit="$2"
  if [ "$dry_run" -eq 1 ]; then
    log "DRY-RUN: systemctl $action $unit"
    return 0
  fi
  log "systemctl $action $unit"
  systemctl_cmd "$action" "$unit"
}

run_optional_service() {
  local action="$1"
  local unit="$2"
  if service_exists "$unit"; then
    if [ "$action" != "stop" ] && ! service_enabled "$unit"; then
      log "skipping $action $unit because the unit is disabled"
      return 0
    fi
    run_service "$action" "$unit"
  elif [ "$dry_run" -eq 1 ]; then
    log "DRY-RUN: systemctl $action $unit (if present)"
  else
    log "skipping $action $unit because the unit is not present"
  fi
}

restart_relay_pool() {
  run_optional_service restart relay-pool.service
}

restart_xtm_mm_service() {
  run_optional_service restart xtm_mm.service
}

wait_json_rpc() {
  local name="$1"
  local url="$2"
  local payload="$3"
  local pattern="$4"
  local limit="${5:-30}"

  if [ "$dry_run" -eq 1 ]; then
    log "DRY-RUN: wait for $name RPC at $url"
    return 0
  fi

  for _ in $(seq 1 "$limit"); do
    local response
    response="$(curl -m 2 -fsS "$url" -H "Content-Type: application/json" -d "$payload" 2>/dev/null || true)"
    if grep -q "$pattern" <<<"$response"; then
      log "$name RPC is reachable"
      return 0
    fi
    sleep 1
  done

  log "$name RPC did not become reachable within ${limit}s"
  return 1
}

wait_monero_rpc() {
  wait_json_rpc \
    "monerod" \
    "$monerod_rpc_url" \
    "$monerod_get_info_payload" \
    '"status"[[:space:]]*:[[:space:]]*"OK"' \
    30
}

# Probe the local Monero RPC before restarting it.  Keep this request short:
# recovery runs from the pool health path and must not wait on a wedged daemon.
monerod_direct_info() {
  [ "$dry_run" -eq 1 ] && return 1
  curl -m 2 --connect-timeout 1 -fsS \
    "$monerod_rpc_url" \
    -H "Content-Type: application/json" \
    -d "$monerod_get_info_payload" \
    2>/dev/null
}

monerod_direct_ready() {
  local response="$1"
  local require_expected_height="$2"
  local actual_height=""

  # Monero's JSON-RPC envelope is {"result":{...}}. Parse it as JSON so a
  # malformed response or an unrelated field cannot make a recovery look safe.
  actual_height="$(printf '%s' "$response" | python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError, ValueError):
    sys.exit(1)
if not isinstance(payload, dict):
    sys.exit(1)
result = payload.get("result")
if not isinstance(result, dict):
    sys.exit(1)
if result.get("status") != "OK" or result.get("synchronized") is not True or result.get("busy_syncing") is not False:
    sys.exit(1)
height = result.get("height")
if isinstance(height, bool) or not isinstance(height, (int, str)):
    sys.exit(1)
try:
    height = int(height)
except (TypeError, ValueError):
    sys.exit(1)
if height < 0:
    sys.exit(1)
print(height)
' 2>/dev/null || true)"
  monerod_direct_height="$actual_height"
  [[ "$actual_height" =~ ^[0-9]+$ ]] || return 1

  if [ "$require_expected_height" -eq 1 ] && [ -z "$expected_xmr_height" ]; then
    return 1
  fi
  if [ -n "$expected_xmr_height" ]; then
    [[ "$expected_xmr_height" =~ ^[0-9]+$ ]] || return 1
    [[ "$actual_height" =~ ^[0-9]+$ ]] || return 1
    [ "$actual_height" -ge "$expected_xmr_height" ] || return 1
  fi
  return 0
}

restart_monerod_if_needed() {
  local require_expected_height="$1"
  local response=""

  if [ "$dry_run" -eq 0 ]; then
    response="$(monerod_direct_info || true)"
    if [ -n "$response" ] && monerod_direct_ready "$response" "$require_expected_height"; then
      if [ -n "$monerod_direct_height" ]; then
        log "skipping restart monero.service: direct monerod RPC is healthy (height=$monerod_direct_height)"
      else
        log "skipping restart monero.service: direct monerod RPC is healthy"
      fi
      return 0
    fi
  fi

  run_service restart monero.service
}

wait_tari_rpc() {
  wait_json_rpc \
    "tari" \
    "http://127.0.0.1:18146/json_rpc" \
    '{"jsonrpc":"2.0","id":"0","method":"GetTipInfo","params":{}}' \
    '"result"[[:space:]]*:' \
    30
}

# A live node with an unavailable RPC is commonly in its one-time LMDB
# migration (or still starting). Restarting it here can interrupt that work
# and make the migration repeat, so defer recovery until the node responds.
tari_rpc_ready() {
  [ "$dry_run" -eq 1 ] && return 0
  local response
  response="$(curl -m 2 -fsS \
    "http://127.0.0.1:18146/json_rpc" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"0","method":"GetTipInfo","params":{}}' \
    2>/dev/null || true)"
  grep -q '"result"[[:space:]]*:' <<<"$response"
}

local_xtm_enabled() {
  service_exists xtm.service && service_enabled xtm.service
}

restart_local_xtm() {
  if ! local_xtm_enabled; then
    log "skipping restart xtm.service because local XTM recovery is disabled"
    return 0
  fi
  run_service restart xtm.service
}

xtm_restart_safe() {
  if ! local_xtm_enabled; then
    # A disabled or masked unit means this host intentionally uses a remote
    # base node. Recovery may restart the local relay/proxy, but must never
    # start the local daemon or attempt to administer the remote daemon.
    log "local XTM recovery is disabled; leaving local and remote Tari daemons untouched"
    return 0
  fi
  if systemctl_cmd is-active --quiet xtm.service && ! tari_rpc_ready; then
    log "deferring xtm restart: active Tari node RPC is unavailable (startup/migration)"
    return 1
  fi
  return 0
}

describe_context() {
  local parts=()
  [ -n "$port" ] && parts+=("port=$port")
  [ -n "$xmr_height" ] && parts+=("xmr_height=$xmr_height")
  [ -n "$expected_xmr_height" ] && parts+=("expected_xmr_height=$expected_xmr_height")
  [ -n "$xtm_height" ] && parts+=("xtm_height=$xtm_height")
  [ -n "$expected_xtm_height" ] && parts+=("expected_xtm_height=$expected_xtm_height")
  if [ "${#parts[@]}" -gt 0 ]; then
    printf ' (%s)' "${parts[*]}"
  fi
}

log "starting $reason recovery$(describe_context)"

case "$reason" in
  xmr-lag|proxy-unhealthy)
    # Without the expected height we cannot distinguish a genuinely lagging
    # node from a stale caller observation, so retain the conservative restart.
    if [ "$reason" = "xmr-lag" ] && [ -z "$expected_xmr_height" ]; then
      run_service restart monero.service
    elif [ "$reason" = "xmr-lag" ]; then
      restart_monerod_if_needed 1
    else
      restart_monerod_if_needed 0
    fi
    restart_relay_pool
    wait_monero_rpc || true
    restart_xtm_mm_service
    ;;
  xtm-lag)
    if ! xtm_restart_safe; then
      log "deferred xtm-lag recovery"
      exit 0
    fi
    restart_local_xtm
    restart_relay_pool
    wait_tari_rpc || true
    restart_xtm_mm_service
    ;;
  template-stuck|unknown|*)
    if ! xtm_restart_safe; then
      log "deferred template recovery: active Tari node RPC is unavailable"
      exit 0
    fi
    restart_monerod_if_needed 0
    restart_local_xtm
    restart_relay_pool
    wait_monero_rpc || true
    wait_tari_rpc || true
    restart_xtm_mm_service
    ;;
esac

log "completed $reason recovery"
