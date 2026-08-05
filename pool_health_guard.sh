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
recovery_success_limit="${POOL_GUARD_RECOVERY_SUCCESS_LIMIT:-2}"
rpc_url="${POOL_GUARD_RPC_URL:-http://127.0.0.1:18081/json_rpc}"
daemon_failure_shutdown_sec="${POOL_GUARD_DAEMON_FAILURE_SHUTDOWN_SEC:-3600}"
daemon_recovery_cooldown_sec="${POOL_GUARD_DAEMON_RECOVERY_COOLDOWN_SEC:-300}"
test_mode="${POOL_GUARD_TEST_MODE:-0}"

mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || exit 0

log() {
  logger -t pool-health-guard "$*" 2>/dev/null || true
  echo "pool-health-guard: $*"
}

now_epoch() {
  if [ "$test_mode" = "1" ] && [[ "${POOL_GUARD_TEST_NOW:-}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$POOL_GUARD_TEST_NOW"
    return
  fi
  date +%s
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
  unlink "$state_dir/daemon-unhealthy-since" 2>/dev/null || true
  unlink "$state_dir/last-daemon-recovery" 2>/dev/null || true
}

quarantine() {
  local reason="$1" percent="$2" now temporary_marker
  now="$(now_epoch)"
  temporary_marker="$marker.tmp.$$"
  printf '%s %s conntrack=%s%%\n' "$now" "$reason" "$percent" >"$temporary_marker"
  mv "$temporary_marker" "$marker"
  unlink "$state_dir/rpc-failures" 2>/dev/null || true
  unlink "$state_dir/recovery-successes" 2>/dev/null || true
  log "quarantining pool: reason=$reason conntrack=${percent}%"
  pm2_cmd stop pool || true
  restart_service xtm_mm.service || true
}

shutdown_for_daemon_outage() {
  local percent="$1" now temporary_marker
  now="$(now_epoch)"
  temporary_marker="$marker.tmp.$$"
  printf '%s daemon-outage conntrack=%s%%\n' "$now" "$percent" >"$temporary_marker"
  mv "$temporary_marker" "$marker"
  log "shutting down pool: daemon RPC unhealthy for ${daemon_failure_shutdown_sec}s"
  pm2_cmd stop pool || true
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

attempt_daemon_recovery() {
  local now last_recovery=0
  now="$(now_epoch)"
  if [ -f "$state_dir/last-daemon-recovery" ]; then
    last_recovery="$(read_uint "$state_dir/last-daemon-recovery" || echo 0)"
  fi
  [ $((now - last_recovery)) -ge "$daemon_recovery_cooldown_sec" ] || return 0
  printf '%s\n' "$now" >"$state_dir/last-daemon-recovery"
  log "merged RPC unhealthy; attempting monero, xtm, and xtm_mm recovery"
  if [ "$test_mode" = "1" ]; then
    log "TEST: $pool_dir/fix_daemon.sh template-stuck"
  elif [ -x "$pool_dir/fix_daemon.sh" ]; then
    "$pool_dir/fix_daemon.sh" template-stuck || true
  fi
}

handle_daemon_failure() {
  local now unhealthy_since=0
  now="$(now_epoch)"
  if [ -f "$state_dir/daemon-unhealthy-since" ]; then
    unhealthy_since="$(read_uint "$state_dir/daemon-unhealthy-since" || echo 0)"
  fi
  if [ "$unhealthy_since" -eq 0 ]; then
    unhealthy_since="$now"
    printf '%s\n' "$unhealthy_since" >"$state_dir/daemon-unhealthy-since"
  fi
  attempt_daemon_recovery
  if [ $((now - unhealthy_since)) -ge "$daemon_failure_shutdown_sec" ]; then
    shutdown_for_daemon_outage "$percent"
  fi
}

percent="$(conntrack_percent)"

if [ -f "$marker" ]; then
  if grep -q ' daemon-outage ' "$marker"; then
    log "node remains shut down: daemon outage marker is present"
    exit 0
  fi
  if [ "$percent" -gt "$recover_percent" ]; then
    unlink "$state_dir/recovery-successes" 2>/dev/null || true
    log "node remains quarantined: conntrack=${percent}%"
    exit 0
  fi
  if ! rpc_healthy; then
    unlink "$state_dir/recovery-successes" 2>/dev/null || true
    attempt_daemon_recovery
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
  unlink "$state_dir/daemon-unhealthy-since" 2>/dev/null || true
  unlink "$state_dir/last-daemon-recovery" 2>/dev/null || true
  exit 0
fi

handle_daemon_failure
