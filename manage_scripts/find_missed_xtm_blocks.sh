#!/bin/bash -x
node dump_altblocks.js >/tmp/altblocks; egrep '"port":(18144|18146),' /tmp/altblocks | grep '"unlocked":true,"valid":true' | sed 's,.\+"height":,,' | sed 's/,.\+//' >/tmp/xtm_blocks
sort /tmp/xtm_blocks >/tmp/xtm_blocks2
curl -X POST http://$1:18145/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"GetCompletedTransactions"}' -H 'Content-Type: application/json' | jq '.result[] | select(.transaction.direction == 1 and .transaction.status == 13)' | jq | grep mined_in_block_height | sed 's, \+"mined_in_block_height": \+",,' | sed 's,",,' >/tmp/wallet_xtm_blocks
sort /tmp/wallet_xtm_blocks >/tmp/wallet_xtm_blocks2
echo Missed XTM blocks
comm -23 /tmp/wallet_xtm_blocks2 /tmp/xtm_blocks2
