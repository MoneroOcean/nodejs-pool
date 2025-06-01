#!/bin/bash -x
node dump_blocks.js >/tmp/blocks; grep '"unlocked":true,"valid":true' /tmp/blocks | sed 's,:.\+,,' >/tmp/xmr_blocks
sort /tmp/xmr_blocks >/tmp/xmr_blocks2
curl -X POST http://localhost:18082/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"get_transfers","params":{"coinbase": true,"in":true}}' -H 'Content-Type: application/json' | jq '.result.in[] | select(.fee == 0)' | grep height | sed 's, \+"height": \+,,' | sed 's/,//' >/tmp/wallet_xmr_blocks
sort /tmp/wallet_xmr_blocks >/tmp/wallet_xmr_blocks2
echo Missed XMR blocks
comm -23 /tmp/wallet_xmr_blocks2 /tmp/xmr_blocks2
