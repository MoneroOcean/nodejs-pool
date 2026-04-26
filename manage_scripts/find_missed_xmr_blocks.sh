#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

node "$script_dir/block_dump.js" >"$tmpdir/blocks"
grep '"unlocked":true,"valid":true' "$tmpdir/blocks" | sed 's,:.\+,,' | LC_ALL=C sort -u >"$tmpdir/xmr_blocks" || :
curl -fsS -X POST "http://localhost:18082/json_rpc" \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_transfers","params":{"coinbase": true,"in":true}}' \
  -H 'Content-Type: application/json' \
  | jq -r '.result.in[]? | select(.fee == 0 and .height != null) | .height' \
  | LC_ALL=C sort -u >"$tmpdir/wallet_xmr_blocks" || :
echo Missed XMR blocks
comm -23 "$tmpdir/wallet_xmr_blocks" "$tmpdir/xmr_blocks"
