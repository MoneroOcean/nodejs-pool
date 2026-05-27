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

usage() {
  cat <<'EOF'
Usage: fix_daemon.sh [--dry-run] <reason> [options]

Reasons:
  xmr-lag             restart monerod and xtm_mm
  proxy-unhealthy     restart monerod and xtm_mm
  xtm-lag             restart local xtm if present/enabled and xtm_mm
  template-stuck      restart monerod, local xtm if present/enabled, and xtm_mm

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
  if [ "$dry_run" -eq 1 ]; then
    log "DRY-RUN: systemctl $action $unit (if present)"
    return 0
  fi
  if service_exists "$unit"; then
    if [ "$action" != "stop" ] && ! service_enabled "$unit"; then
      log "skipping $action $unit because the unit is disabled"
      return 0
    fi
    run_service "$action" "$unit"
  else
    log "skipping $action $unit because the unit is not present"
  fi
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
    "http://127.0.0.1:18083/json_rpc" \
    '{"jsonrpc":"2.0","id":"0","method":"get_info"}' \
    '"status"[[:space:]]*:[[:space:]]*"OK"' \
    30
}

wait_tari_rpc() {
  wait_json_rpc \
    "tari" \
    "http://127.0.0.1:18146/json_rpc" \
    '{"jsonrpc":"2.0","id":"0","method":"GetTipInfo","params":{}}' \
    '"result"[[:space:]]*:' \
    30
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
    run_service stop xtm_mm.service || true
    run_service restart monero.service
    wait_monero_rpc || true
    run_service start xtm_mm.service
    ;;
  xtm-lag)
    run_service stop xtm_mm.service || true
    run_optional_service restart xtm.service
    if service_exists xtm.service || [ "$dry_run" -eq 1 ]; then
      wait_tari_rpc || true
    fi
    run_service start xtm_mm.service
    ;;
  template-stuck|unknown|*)
    run_service stop xtm_mm.service || true
    run_service restart monero.service
    run_optional_service restart xtm.service
    wait_monero_rpc || true
    if service_exists xtm.service || [ "$dry_run" -eq 1 ]; then
      wait_tari_rpc || true
    fi
    run_service start xtm_mm.service
    ;;
esac

log "completed $reason recovery"
