#!/bin/bash
set -euo pipefail

MONERO_SRC="${1:-/usr/local/src/monero}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/patches/monero-tari-mm-reserve.patch"
TARGET_FILE="$MONERO_SRC/src/cryptonote_core/blockchain.cpp"
RPC_TARGET_FILE="$MONERO_SRC/src/rpc/core_rpc_server.cpp"
PATCH_MARKER="MONEROOCEAN_TARI_MERGE_MINING_WEIGHT_SIZE"
OLD_RPC_PATCH_MARKER="MONEROOCEAN_TARI_MERGE_MINING_DATA_SIZE"

if [ ! -d "$MONERO_SRC/.git" ]; then
  echo "Monero source directory is not a git checkout: $MONERO_SRC" >&2
  exit 1
fi

if [ ! -f "$PATCH_FILE" ]; then
  echo "Required Monero patch is missing: $PATCH_FILE" >&2
  exit 1
fi

if [ ! -f "$TARGET_FILE" ]; then
  echo "Monero blockchain source file is missing: $TARGET_FILE" >&2
  exit 1
fi

git_monero() {
  git -C "$MONERO_SRC" -c safe.directory="$MONERO_SRC" "$@"
}

if [ -f "$RPC_TARGET_FILE" ] && grep -Fq "$OLD_RPC_PATCH_MARKER" "$RPC_TARGET_FILE"; then
  echo "Obsolete MoneroOcean Tari RPC reserve patch is still present in $RPC_TARGET_FILE" >&2
  echo "Revert that RPC patch before applying the blockchain reward-weight workaround." >&2
  exit 1
fi

if ! grep -Fq "$PATCH_MARKER" "$TARGET_FILE"; then
  git_monero apply --check --unidiff-zero "$PATCH_FILE"
  git_monero apply --unidiff-zero "$PATCH_FILE"
fi

if ! grep -Fq "$PATCH_MARKER" "$TARGET_FILE"; then
  echo "MoneroOcean Tari reward-weight patch marker was not found after patching" >&2
  exit 1
fi

git_monero diff --check -- "$TARGET_FILE"

echo "MoneroOcean Tari merge-mining reward-weight patch is applied in $MONERO_SRC"
