#!/usr/bin/env bash
set -euo pipefail

pool_user="${POOL_GUARD_USER:-user}"
pool_home="${POOL_GUARD_HOME:-/home/$pool_user}"
state_dir="${POOL_GUARD_STATE_DIR:-/run/pool-health-guard}"
quarantine_file="$state_dir/quarantine"
conntrack_count_file="${POOL_GUARD_CONNTRACK_COUNT_FILE:-/proc/sys/net/netfilter/nf_conntrack_count}"
conntrack_max_file="${POOL_GUARD_CONNTRACK_MAX_FILE:-/proc/sys/net/netfilter/nf_conntrack_max}"
# With the leaf default of 524288 entries, intervene at about 288k and wait
# until pressure falls to about 210k before restarting the pool. Healthy leaves
# normally sit around 130k-160k entries, so this retains useful headroom while
# avoiding the load already observed well below the old 80% of a 1M table.
trip_percent="${POOL_GUARD_TRIP_PERCENT:-55}"
recover_percent="${POOL_GUARD_RECOVER_PERCENT:-40}"
recovery_success_limit="${POOL_GUARD_RECOVERY_SUCCESS_LIMIT:-2}"
rpc_url="${POOL_GUARD_RPC_URL:-http://127.0.0.1:18081/json_rpc}"
rpc_timeout_sec="${POOL_GUARD_RPC_TIMEOUT_SEC:-20}"
daemon_failure_shutdown_sec="${POOL_GUARD_DAEMON_FAILURE_SHUTDOWN_SEC:-3600}"
max_block_age_sec="${POOL_GUARD_MAX_BLOCK_AGE_SEC:-10800}"
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
  count="$(read_uint "$conntrack_count_file")" || return 1
  max="$(read_uint "$conntrack_max_file")" || return 1
  [ "$max" -gt 0 ] || return 1
  echo $((count * 100 / max))
}

pm2_cmd() {
  if [ "$test_mode" = "1" ]; then
    log "TEST: pm2 $*"
    return 0
  fi
  setpriv --reuid="$pool_user" --regid="$pool_user" --init-groups \
    env HOME="$pool_home" PM2_HOME="$pool_home/.pm2" /bin/bash -c \
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

last_good_block_epoch() {
  if [ "$test_mode" = "1" ]; then
    [ "${POOL_GUARD_TEST_RPC_HEALTHY:-1}" = "1" ] || return 1
    local main_timestamp aux_timestamp
    main_timestamp="${POOL_GUARD_TEST_LAST_BLOCK_TIMESTAMP:-$(now_epoch)}"
    aux_timestamp="${POOL_GUARD_TEST_AUX_BLOCK_TIMESTAMP:-$main_timestamp}"
    [[ "$main_timestamp" =~ ^[0-9]+$ && "$aux_timestamp" =~ ^[0-9]+$ ]] || return 1
    if [ "$main_timestamp" -le "$aux_timestamp" ]; then
      printf '%s\n' "$main_timestamp"
    else
      printf '%s\n' "$aux_timestamp"
    fi
    return
  fi
  local response
  response="$(curl -m "$rpc_timeout_sec" -fsS "$rpc_url" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":"0","method":"get_last_block_header"}' 2>/dev/null || true)"
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"OK"' <<<"$response" || return 1
  printf '%s' "$response" | python3 -c '
import json
import sys
try:
    result = json.load(sys.stdin)["result"]
    timestamps = [result["block_header"]["timestamp"]]
    aux_chains = result["_aux"]["chains"]
    if not aux_chains:
        raise ValueError
    timestamps.extend(chain["block_header"]["timestamp"] for chain in aux_chains)
    if any(not isinstance(timestamp, int) or timestamp < 0 for timestamp in timestamps):
        raise ValueError
    print(min(timestamps))
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    sys.exit(1)
'
}

daemon_healthy() {
  local block_epoch now age
  block_epoch="$(last_good_block_epoch)" || return 2
  [[ "$block_epoch" =~ ^[0-9]+$ ]] || return 2
  now="$(now_epoch)"
  age=$((now - block_epoch))
  [ "$age" -le "$max_block_age_sec" ] && return 0
  return 1
}

counter_increment() {
  local name="$1" value=0 file="$state_dir/$1"
  if [ -f "$file" ]; then value="$(read_uint "$file" || echo 0)"; fi
  value=$((value + 1))
  printf '%s\n' "$value" >"$file"
  echo "$value"
}

clear_runtime_state() {
  unlink "$state_dir/recovery-successes" 2>/dev/null || true
  unlink "$state_dir/daemon-unhealthy-since" 2>/dev/null || true
  unlink "$quarantine_file" 2>/dev/null || true
}

quarantine() {
  local reason="$1" percent="$2" now temporary_file
  now="$(now_epoch)"
  temporary_file="$quarantine_file.tmp.$$"
  printf '%s %s conntrack=%s%%\n' "$now" "$reason" "$percent" >"$temporary_file"
  mv "$temporary_file" "$quarantine_file"
  unlink "$state_dir/recovery-successes" 2>/dev/null || true
  log "quarantining pool: reason=$reason conntrack=${percent}%"
  pm2_cmd stop pool || true
}

shutdown_for_daemon_outage() {
  local percent="$1" now temporary_file
  now="$(now_epoch)"
  temporary_file="$quarantine_file.tmp.$$"
  printf '%s daemon-outage conntrack=%s%%\n' "$now" "$percent" >"$temporary_file"
  mv "$temporary_file" "$quarantine_file"
  log "shutting down pool: no fresh daemon block for ${daemon_failure_shutdown_sec}s"
  pm2_cmd stop pool || true
}

recover_pool() {
  local quarantine_contents
  quarantine_contents="$(cat "$quarantine_file")"
  unlink "$quarantine_file"
  if pm2_cmd restart pool; then
    clear_runtime_state
    log "pool recovered and returned to health checks"
    return 0
  fi
  printf '%s\n' "$quarantine_contents" >"$quarantine_file"
  log "pool restart failed; keeping node quarantined"
  return 1
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
  if [ $((now - unhealthy_since)) -ge "$daemon_failure_shutdown_sec" ]; then
    shutdown_for_daemon_outage "$percent"
  fi
}

if ! percent="$(conntrack_percent)"; then
  if [ ! -f "$state_dir/conntrack-unavailable" ]; then
    : >"$state_dir/conntrack-unavailable"
    log "conntrack counters unavailable; skipping pressure decision"
  fi
  exit 0
fi
unlink "$state_dir/conntrack-unavailable" 2>/dev/null || true

if [ -f "$quarantine_file" ]; then
  if [ "$percent" -gt "$recover_percent" ]; then
    unlink "$state_dir/recovery-successes" 2>/dev/null || true
    log "node remains quarantined: conntrack=${percent}%"
    exit 0
  fi
  if ! daemon_healthy; then
    unlink "$state_dir/recovery-successes" 2>/dev/null || true
    log "node remains quarantined: no fresh daemon block"
    exit 0
  fi
  successes="$(counter_increment recovery-successes)"
  if [ "$successes" -ge "$recovery_success_limit" ]; then recover_pool; fi
  exit 0
fi

pool_is_online || exit 0

if [ "$percent" -ge "$trip_percent" ]; then
  quarantine conntrack-pressure "$percent"
  exit 0
fi

daemon_health=0
daemon_healthy || daemon_health=$?
if [ "$daemon_health" -eq 0 ]; then
  unlink "$state_dir/daemon-unhealthy-since" 2>/dev/null || true
  exit 0
fi

if [ "$daemon_health" -eq 1 ]; then
  handle_daemon_failure
else
  # A transient proxy/RPC failure does not prove that any chain is stale.
  # Only a successfully read header older than max_block_age_sec starts the
  # shutdown timer.
  unlink "$state_dir/daemon-unhealthy-since" 2>/dev/null || true
  log "merged RPC unavailable; not treating it as a stale daemon block"
fi
