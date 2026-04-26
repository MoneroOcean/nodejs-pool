#!/bin/bash
set -euo pipefail

subject="${1-}"
body="${2-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$subject" ]; then echo "Set subject as first script parameter"; exit 1; fi
if [ -z "$body" ]; then echo "Set body as second script parameter"; exit 1; fi

value="$(node -e 'process.stdout.write(JSON.stringify({ created: String(Math.floor(Date.now() / 1000)), subject: process.argv[1], body: process.argv[2] }))' "$subject" "$body")"
node "$script_dir/cache_value_set.js" --key=news --value="$value"
