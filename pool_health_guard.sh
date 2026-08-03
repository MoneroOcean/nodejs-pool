#!/usr/bin/env bash
set -euo pipefail

pool_user="${POOL_GUARD_USER:-user}"
pool_home="${POOL_GUARD_HOME:-/home/$pool_user}"
pool_dir="${POOL_GUARD_POOL_DIR:-$pool_home/nodejs-pool}"
state_dir="${POOL_GUARD_STATE_DIR:-/run/pool-health-guard}"
marker="${POOL_GUARD_MARKER:-$pool_dir/pool_health_guard_unhealthy}"
conntrack_count_file="${POOL_GUARD_CONNTRACK_COUNT_FILE:-/proc/sys/net/netfilter/nf_conntrack_count}"
conntrack_max_file="${POOL_GUARD_CONNTRACK_MAX_FILE:-/proc/sys/net/netfilter/nf_conntrack_max}"
trip_percent="${POOL_GUARD_TRIP_PERCENT:-80}"
recover_percent="${POOL_GUARD_RECOVER_PERCENT:-50}"
rpc_failure_limit="${POOL_GUARD_RPC_FAILURE_LIMIT:-3}"
recovery_success_limit="${POOL_GUARD_RECOVERY_SUCCESS_LIMIT:-2}"
rpc_url="${POOL_GUARD_RPC_URL:-http://127.0.0.1:18081/json_rpc}"
test_mode="${POOL_GUARD_TEST_MODE:-0}"

mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || exit 0

log() {
  logger -t pool-health-guard "$*" 2>/dev/null || true
  echo "pool-health-guard: $*"
}

read_uint() {
  local value
  value="$(cat "$1" 2>/dev/null || true)"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

conntrack_percent() {
  local count max
  count="$(read_uint "$conntrack_count_file")" || { echo 0; return; }
  max="$(read_uint "$conntrack_max_file")" || { echo 0; return; }
  [ "$max" -gt 0 ] || { echo 0; return; }
  echo $((count * 100 / max))
}

pm2_cmd() {
  if [ "$test_mode" = "1" ]; then
    log "TEST: pm2 $*"
    return 0
  fi
  runuser -u "$pool_user" -- env HOME="$pool_home" /bin/bash -c \
    '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; pm2 "$@"' bash "$@"
}

pool_is_online() {
  if [ "$test_mode" = "1" ]; then
    [ "${POOL_GUARD_TEST_POOL_ONLINE:-1}" = "1" ]
    return
  fi
  local pid
  pid="$(pm2_cmd pid pool 2>/dev/null | tail -n 1 || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
}

rpc_healthy() {
  if [ "$test_mode" = "1" ]; then
    [ "${POOL_GUARD_TEST_RPC_HEALTHY:-1}" = "1" ]
    return
  fi
  local response
  response="$(curl -m 3 -fsS "$rpc_url" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":"0","method":"get_last_block_header"}' 2>/dev/null || true)"
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"OK"' <<<"$response"
}

restart_service() {
  local unit="$1"
  if [ "$test_mode" = "1" ]; then
    log "TEST: systemctl restart $unit"
  elif systemctl cat "$unit" >/dev/null 2>&1; then
    systemctl restart "$unit"
  fi
}

counter_increment() {
  local name="$1" value=0 file="$state_dir/$1"
  if [ -f "$file" ]; then value="$(read_uint "$file" || echo 0)"; fi
  value=$((value + 1))
  printf '%s\n' "$value" >"$file"
  echo "$value"
}

clear_runtime_state() {
  unlink "$state_dir/rpc-failures" 2>/dev/null || true
  unlink "$state_dir/recovery-successes" 2>/dev/null || true
  unlink "$state_dir/full-repair-attempted" 2>/dev/null || true
}

quarantine() {
  local reason="$1" percent="$2" now temporary_marker
  now="$(date +%s)"
  temporary_marker="$marker.tmp.$$"
  printf '%s %s conntrack=%s%%\n' "$now" "$reason" "$percent" >"$temporary_marker"
  mv "$temporary_marker" "$marker"
  unlink "$state_dir/rpc-failures" 2>/dev/null || true
  unlink "$state_dir/recovery-successes" 2>/dev/null || true
  log "quarantining pool: reason=$reason conntrack=${percent}%"
  pm2_cmd stop pool || true
  restart_service xtm_mm.service || true
}

recover_pool() {
  local marker_contents
  marker_contents="$(cat "$marker")"
  unlink "$marker"
  if pm2_cmd restart pool; then
    clear_runtime_state
    log "pool recovered and returned to health checks"
    return 0
  fi
  printf '%s\n' "$marker_contents" >"$marker"
  log "pool restart failed; keeping node quarantined"
  return 1
}

repair_proxy_once() {
  local quarantined_at now
  [ ! -e "$state_dir/full-repair-attempted" ] || return 0
  quarantined_at="$(awk 'NR == 1 {print $1}' "$marker" 2>/dev/null || true)"
  [[ "$quarantined_at" =~ ^[0-9]+$ ]] || return 0
  now="$(date +%s)"
  [ $((now - quarantined_at)) -ge 60 ] || return 0
  : >"$state_dir/full-repair-attempted"
  log "merged RPC remains unhealthy; running one full proxy recovery"
  if [ "$test_mode" = "1" ]; then
    log "TEST: $pool_dir/fix_daemon.sh proxy-unhealthy"
  elif [ -x "$pool_dir/fix_daemon.sh" ]; then
    "$pool_dir/fix_daemon.sh" proxy-unhealthy || true
  fi
}

percent="$(conntrack_percent)"

if [ -f "$marker" ]; then
  if [ "$percent" -gt "$recover_percent" ]; then
    unlink "$state_dir/recovery-successes" 2>/dev/null || true
    log "node remains quarantined: conntrack=${percent}%"
    exit 0
  fi
  if ! rpc_healthy; then
    unlink "$state_dir/recovery-successes" 2>/dev/null || true
    repair_proxy_once
    log "node remains quarantined: merged RPC unhealthy"
    exit 0
  fi
  successes="$(counter_increment recovery-successes)"
  if [ "$successes" -ge "$recovery_success_limit" ]; then recover_pool; fi
  exit 0
fi

pool_is_online || { unlink "$state_dir/rpc-failures" 2>/dev/null || true; exit 0; }

if [ "$percent" -ge "$trip_percent" ]; then
  quarantine conntrack-pressure "$percent"
  exit 0
fi

if rpc_healthy; then
  unlink "$state_dir/rpc-failures" 2>/dev/null || true
  exit 0
fi

failures="$(counter_increment rpc-failures)"
if [ "$failures" -ge "$rpc_failure_limit" ]; then
  quarantine merged-rpc-unhealthy "$percent"
fi
