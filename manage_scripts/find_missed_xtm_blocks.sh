#!/bin/bash
set -euo pipefail

host="${1-}"
if [ -z "$host" ]; then echo "Set wallet host as first script parameter"; exit 1; fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

node dump_altblocks.js >"$tmpdir/altblocks"
egrep '"port":(18144|18146),' "$tmpdir/altblocks" | grep '"unlocked":true,"valid":true' | sed 's,.\+"height":,,' | sed 's/,.\+//' >"$tmpdir/xtm_blocks" || :
sort "$tmpdir/xtm_blocks" >"$tmpdir/xtm_blocks2"
curl -fsS -X POST "http://$host:18145/json_rpc" -d '{"jsonrpc":"2.0","id":"0","method":"GetCompletedTransactions"}' -H 'Content-Type: application/json' | jq '.result[] | select(.transaction.direction == 1 and .transaction.status == 13)' | jq | grep mined_in_block_height | sed 's, \+"mined_in_block_height": \+",,' | sed 's,",,' >"$tmpdir/wallet_xtm_blocks" || :
sort "$tmpdir/wallet_xtm_blocks" >"$tmpdir/wallet_xtm_blocks2"
echo Missed XTM blocks
comm -23 "$tmpdir/wallet_xtm_blocks2" "$tmpdir/xtm_blocks2"
