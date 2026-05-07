#!/bin/bash
set -euo pipefail

MONERO_SRC="${1:-/usr/local/src/monero}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/patches/monero-tari-mm-reserve.patch"
TARGET_FILE="$MONERO_SRC/src/rpc/core_rpc_server.cpp"
PATCH_MARKER="MONEROOCEAN_TARI_MERGE_MINING_DATA_SIZE"

if [ ! -d "$MONERO_SRC/.git" ]; then
  echo "Monero source directory is not a git checkout: $MONERO_SRC" >&2
  exit 1
fi

if [ ! -f "$PATCH_FILE" ]; then
  echo "Required Monero patch is missing: $PATCH_FILE" >&2
  exit 1
fi

if [ ! -f "$TARGET_FILE" ]; then
  echo "Monero RPC source file is missing: $TARGET_FILE" >&2
  exit 1
fi

git_monero() {
  git -C "$MONERO_SRC" -c safe.directory="$MONERO_SRC" "$@"
}

if ! grep -Fq "$PATCH_MARKER" "$TARGET_FILE"; then
  git_monero apply --check "$PATCH_FILE"
  git_monero apply "$PATCH_FILE"
fi

if ! grep -Fq "$PATCH_MARKER" "$TARGET_FILE"; then
  echo "MoneroOcean Tari reserve patch marker was not found after patching" >&2
  exit 1
fi

if ! git_monero apply --reverse --check "$PATCH_FILE"; then
  echo "MoneroOcean Tari reserve patch is not applied cleanly" >&2
  exit 1
fi

echo "MoneroOcean Tari merge-mining reserve patch is applied in $MONERO_SRC"
