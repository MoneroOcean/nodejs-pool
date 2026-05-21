#!/bin/bash
set -e

MONERO_REPO_URL="${MONERO_REPO_URL:-https://github.com/monero-project/monero.git}"
MONERO_RELEASE_TAG="${MONERO_RELEASE_TAG:-v0.18.4.6}"
TARI_REPO_URL="${TARI_REPO_URL:-https://github.com/tari-project/tari.git}"
TARI_RELEASE_TAG="${TARI_RELEASE_TAG:-v5.3.1}"
TARI_NETWORK="${TARI_NETWORK:-mainnet}"

retry_command() { for i in 1 2 3 4 5; do "$@" && return 0; [ "$i" = 5 ] || sleep $((i * 5)); done; return 1; }

ensure_rust_toolchain() {
  sudo bash -lc '
    set -e
    if [ -s /root/.cargo/env ]; then
      . /root/.cargo/env
    fi
    if ! command -v cargo >/dev/null 2>&1; then
      curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
      . /root/.cargo/env
    fi
    rustup update stable
  '
}

checkout_repo_ref() {
  local repo="$1"
  local dest="$2"
  local ref="$3"
  if [ -e "$dest" ] && [ ! -d "$dest/.git" ]; then
    sudo mv "$dest" "$dest.pre-source.$(date +%Y%m%d%H%M%S)"
  fi
  if [ ! -d "$dest/.git" ]; then
    sudo git clone "$repo" "$dest"
  fi
  cd "$dest"
  sudo git fetch --tags origin
  sudo git reset --hard
  sudo git checkout --force "$ref"
}

echo "This builds updated Monero and Tari daemons from source. It does not restart services for you."
sleep 5

sudo apt-get -o Acquire::Retries=3 update
sudo apt-get -o Acquire::Retries=3 install -y ca-certificates curl git g++ make libc-dev cmake pkg-config autoconf automake libtool libssl-dev libsqlite3-dev sqlite3 clang libc++-dev libc++abi-dev libprotobuf-dev protobuf-compiler libncurses5-dev libncursesw5-dev libunbound-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libzmq3-dev

echo "Building clean Monero $MONERO_RELEASE_TAG"
checkout_repo_ref "$MONERO_REPO_URL" /usr/local/src/monero "$MONERO_RELEASE_TAG"
sudo git submodule update --force --recursive --init
sudo rm -rf build
sudo USE_SINGLE_BUILDDIR=1 nice make release

echo "Building Tari $TARI_RELEASE_TAG"
ensure_rust_toolchain
checkout_repo_ref "$TARI_REPO_URL" /usr/local/src/tari "$TARI_RELEASE_TAG"
sudo TARI_TARGET_NETWORK="$TARI_NETWORK" bash -lc ". /root/.cargo/env && cd /usr/local/src/tari && cargo build --release -p minotari_node -p minotari_merge_mining_proxy"

echo "Done. Restart when ready: sudo systemctl restart monero xtm xtm_mm"
