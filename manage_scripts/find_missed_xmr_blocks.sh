#!/bin/bash
set -euo pipefail

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

node dump_blocks.js >"$tmpdir/blocks"
grep '"unlocked":true,"valid":true' "$tmpdir/blocks" | sed 's,:.\+,,' >"$tmpdir/xmr_blocks" || :
sort "$tmpdir/xmr_blocks" >"$tmpdir/xmr_blocks2"
curl -fsS -X POST "http://localhost:18082/json_rpc" -d '{"jsonrpc":"2.0","id":"0","method":"get_transfers","params":{"coinbase": true,"in":true}}' -H 'Content-Type: application/json' | jq '.result.in[] | select(.fee == 0)' | grep height | sed 's, \+"height": \+,,' | sed 's/,//' >"$tmpdir/wallet_xmr_blocks" || :
sort "$tmpdir/wallet_xmr_blocks" >"$tmpdir/wallet_xmr_blocks2"
echo Missed XMR blocks
comm -23 "$tmpdir/wallet_xmr_blocks2" "$tmpdir/xmr_blocks2"
