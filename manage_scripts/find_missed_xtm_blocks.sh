#!/bin/bash
set -euo pipefail

host="${1-}"
if [ -z "$host" ]; then echo "Set wallet host as first script parameter"; exit 1; fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

node "$script_dir/dump_altblocks.js" >"$tmpdir/altblocks"
egrep '"port":(18144|18146|18148),' "$tmpdir/altblocks" | grep '"unlocked":true,"valid":true' | sed 's,.\+"height":,,' | sed 's/,.\+//' | LC_ALL=C sort -u >"$tmpdir/xtm_blocks" || :
curl -fsS -X POST "http://$host:18145/json_rpc" \
  -d '{"jsonrpc":"2.0","id":"0","method":"GetCompletedTransactions"}' \
  -H 'Content-Type: application/json' \
  | jq -r '.result[]? | select(.transaction.direction == 1 and .transaction.status == 13 and .transaction.mined_in_block_height != null) | .transaction.mined_in_block_height' \
  | LC_ALL=C sort -u >"$tmpdir/wallet_xtm_blocks" || :
echo Missed XTM blocks
comm -23 "$tmpdir/wallet_xtm_blocks" "$tmpdir/xtm_blocks"
