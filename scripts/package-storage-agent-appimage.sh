#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/wsl-env.sh
quorum_context=$(mktemp -d)
trap 'rm -rf "$quorum_context"' EXIT
cp scripts/appimage/Dockerfile "$quorum_context/"
cp scripts/storage-agent-runtime-lock.json "$quorum_context/"
docker build --platform linux/amd64 -t quorum-agent-appimage-builder "$quorum_context"
# This output tree contains generated program artifacts only.
rm -rf release/appimage
mkdir -p release/appimage
mkdir -p .tools/appimage-cargo-registry .tools/appimage-cargo-git .tools/appimage-target
# Copy tracked source plus scoped new packaging files; never send .env or user data.
git ls-files -z | tar --null -T - -cf "$quorum_context/source.tar"
tar --append -f "$quorum_context/source.tar" scripts/appimage scripts/package-storage-agent-appimage.sh
# Build in container-local storage; only generated release artifacts cross back.
docker run --rm --platform linux/amd64 --cpus 4 \
    -v "$quorum_context/source.tar:/source.tar:ro" \
    -v "$PWD/release/appimage:/output" \
    -v "$PWD/.tools/appimage-cargo-registry:/opt/cargo/registry" \
    -v "$PWD/.tools/appimage-cargo-git:/opt/cargo/git" \
    -v "$PWD/.tools/appimage-target:/work/packages/storage-agent-desktop/target" \
    -e CARGO_BUILD_JOBS=4 \
    -e QUORUM_OUTPUT_UID="$(id -u)" -e QUORUM_OUTPUT_GID="$(id -g)" \
    quorum-agent-appimage-builder bash -c \
    'trap '\''chown -R "$QUORUM_OUTPUT_UID:$QUORUM_OUTPUT_GID" /output /opt/cargo/registry /opt/cargo/git /work/packages/storage-agent-desktop/target'\'' EXIT; tar -xf /source.tar -C /work; bash scripts/appimage/build-inside.sh'

# A clean runtime image catches dependencies accidentally supplied by the compiler image.
cp scripts/appimage/Dockerfile.smoke "$quorum_context/Dockerfile.smoke"
docker build --platform linux/amd64 -f "$quorum_context/Dockerfile.smoke" -t quorum-agent-appimage-smoke "$quorum_context"
docker run --rm --platform linux/amd64 \
    -v "$PWD/release/appimage:/artifacts:ro" \
    -v "$PWD/scripts/appimage:/checks:ro" \
    quorum-agent-appimage-smoke sh -c \
    'set -- /artifacts/*.AppImage; test "$#" = 1; python3 /checks/smoke.py "$1"'

node scripts/chair-agent-downloads.mjs record-linux release/appimage
