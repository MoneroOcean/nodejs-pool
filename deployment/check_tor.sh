#!/usr/bin/env bash
set -euo pipefail

SERVICE="${TOR_SERVICE:-tor@default.service}"
LOG_FILE="${TOR_WATCHDOG_LOG:-/var/log/tor-watchdog.log}"
LOCK_FILE="${TOR_WATCHDOG_LOCK:-/run/tor-watchdog.lock}"
FORCE_RESTART_SECONDS="${TOR_FORCE_RESTART_SECONDS:-21600}"
BOOTSTRAP_GRACE_SECONDS="${TOR_BOOTSTRAP_GRACE_SECONDS:-600}"


validate_non_negative_integer() {
    local name="$1"
    local value="$2"
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
        printf 'Invalid %s: %q\n' "$name" "$value" >&2
        exit 1
    fi
}

validate_non_negative_integer "TOR_FORCE_RESTART_SECONDS" "$FORCE_RESTART_SECONDS"
validate_non_negative_integer "TOR_BOOTSTRAP_GRACE_SECONDS" "$BOOTSTRAP_GRACE_SECONDS"
log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"
}

restart_tor() {
    local reason="$1"
    log "restarting ${SERVICE}: ${reason}"
    systemctl restart "$SERVICE"
}

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

touch "$LOG_FILE"

now="$(date +%s)"
reason=""
active_epoch=""

if ! systemctl is-active --quiet "$SERVICE"; then
    reason="service is not active"
else
    main_pid="$(systemctl show -P MainPID "$SERVICE" 2>/dev/null || printf '0')"
    if [[ "$main_pid" == "0" ]] || ! kill -0 "$main_pid" 2>/dev/null; then
        reason="main process is missing"
    fi
fi

if [[ -z "$reason" ]]; then
    active_at="$(systemctl show -P ActiveEnterTimestamp "$SERVICE" 2>/dev/null || true)"
    if [[ -n "$active_at" && "$active_at" != "n/a" ]]; then
        active_epoch="$(date -d "$active_at" +%s 2>/dev/null || true)"
    fi

    if [[ -n "$active_epoch" && $((now - active_epoch)) -gt "$BOOTSTRAP_GRACE_SECONDS" ]]; then
        if ! journalctl -u "$SERVICE" --since "@${active_epoch}" --no-pager 2>/dev/null | grep -q 'Bootstrapped 100% (done): Done'; then
            reason="bootstrap did not complete within ${BOOTSTRAP_GRACE_SECONDS}s"
        fi
    fi
fi

if [[ -n "$reason" ]]; then
    restart_tor "$reason"
    exit 0
fi

if [[ -n "$active_epoch" && $((now - active_epoch)) -ge "$FORCE_RESTART_SECONDS" ]]; then
    restart_tor "scheduled refresh after ${FORCE_RESTART_SECONDS}s service runtime"
fi
