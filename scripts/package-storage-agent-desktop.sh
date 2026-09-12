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
cargo build --release --locked --manifest-path packages/storage-agent-desktop/Cargo.toml
node scripts/build-storage-agent-release.mjs --target linux-x64 --output release/storage-agent-desktop-core "$@"
# This directory contains generated program files only, never user configuration.
quorum_desktop_output="$PWD/release/storage-agent-desktop"
mkdir -p "$quorum_desktop_output"
cp -a release/storage-agent-desktop-core/staging/quorum-storage-agent-0.1.0-linux-x64/. "$quorum_desktop_output/"
cp packages/storage-agent-desktop/target/release/quorum-storage-agent-desktop "$quorum_desktop_output/"
cp packages/storage-agent-desktop/README.md "$quorum_desktop_output/DESKTOP.md"
cp LICENSE "$quorum_desktop_output/LICENSE.Quorum"
printf '%s\n' "$quorum_desktop_output/quorum-storage-agent-desktop"
