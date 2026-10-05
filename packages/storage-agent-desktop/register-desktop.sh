#!/usr/bin/env bash
set -euo pipefail
# Registers this stable release path for the current user; no root or service required.
exec "$(dirname "$(readlink -f "$0")")/quorum-storage-agent-desktop" --register
