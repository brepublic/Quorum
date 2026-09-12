#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/wsl-env.sh
if [ -x "$PWD/.tools/cargo/bin/cargo" ]; then
  export CARGO_HOME="$PWD/.tools/cargo"
  export RUSTUP_HOME="$PWD/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
pnpm --filter @quorum/contracts build
pnpm --filter @quorum/storage-agent build
export QUORUM_AGENT_NODE="$(command -v node)"
export QUORUM_AGENT_BRIDGE="$PWD/packages/storage-agent/dist/desktop-bridge.js"
exec cargo run --locked --manifest-path packages/storage-agent-desktop/Cargo.toml -- "$@"
