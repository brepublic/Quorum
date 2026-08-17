#!/usr/bin/env bash

# Source this file from the repository root before running project tools:
#   source scripts/wsl-env.sh
# It prefers the repository-local WSL toolchain when installed, while allowing
# a normal system-wide Node/Java installation as a fallback.

_quorum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -x "$_quorum_root/.tools/node/bin/node" ]; then
  export PATH="$_quorum_root/.tools/node/bin:$_quorum_root/.tools/bin:$PATH"
fi

if [ -x "$_quorum_root/.tools/java/bin/java" ]; then
  export JAVA_HOME="$_quorum_root/.tools/java"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# Some WSL terminals inherit a Windows TEMP path that does not exist in Linux.
export TMPDIR="${TMPDIR:-/tmp}"
export TEMP="${TEMP:-$TMPDIR}"
export TMP="${TMP:-$TMPDIR}"

unset _quorum_root
