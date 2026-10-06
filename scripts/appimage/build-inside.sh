#!/bin/bash
set -euo pipefail
cd /work
# The container contains a clean source copy; no host node_modules or Rust target.
pnpm install --frozen-lockfile
pnpm --filter @quorum/contracts build
pnpm --filter @quorum/storage-agent build
cargo test --locked --manifest-path packages/storage-agent-desktop/Cargo.toml
cargo build --release --locked --manifest-path packages/storage-agent-desktop/Cargo.toml
python3 scripts/appimage/test-package.py packages/storage-agent-desktop/target/release/quorum-storage-agent-desktop
cargo build --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --example ui-preview
packages/storage-agent-desktop/target/debug/examples/ui-preview --offscreen --settings --paired --small --exercise-overwrite
pnpm exec vitest run scripts/storage-agent-release.test.ts packages/storage-agent/src/desktop-bridge.test.ts packages/storage-agent/src/runtime-lock.test.ts
node scripts/build-storage-agent-release.mjs --target linux-x64
version=$(node -p "JSON.parse(require('fs').readFileSync('packages/storage-agent/package.json')).version")
appdir=/work/release/appimage/Quorum-Chair-Agent.AppDir
mkdir -p "$appdir"
cp -a "release/storage-agent/staging/quorum-storage-agent-$version-linux-x64/." "$appdir/"
cp packages/storage-agent-desktop/target/release/quorum-storage-agent-desktop "$appdir/"
cp scripts/appimage/{AppRun,install.sh,prepare-fonts.cjs} "$appdir/"
cp LICENSE "$appdir/LICENSE.Quorum"
mkdir -p "$appdir/usr/share/metainfo"
cp scripts/appimage/org.quorum.ChairAgent.metainfo.xml "$appdir/usr/share/metainfo/org.quorum.ChairAgent.appdata.xml"
cp scripts/appimage/INSTALL.md "$appdir/INSTALL.md"
cp packages/storage-agent-desktop/assets/quorum-agent.svg "$appdir/org.quorum.ChairAgent.svg"
cat > "$appdir/org.quorum.ChairAgent.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Quorum Chair Agent
Name[zh_CN]=Quorum 主席 Agent
Exec=AppRun --open %u
Icon=org.quorum.ChairAgent
StartupWMClass=org.quorum.ChairAgent
Terminal=false
Categories=Office;
MimeType=x-scheme-handler/quorum-agent;application/x-quorum-agent-pairing;
EOF
desktop-file-validate "$appdir/org.quorum.ChairAgent.desktop"
for size in 48 128 256; do
    mkdir -p "$appdir/usr/share/icons/hicolor/${size}x${size}/apps"
    rsvg-convert -w "$size" -h "$size" "$appdir/org.quorum.ChairAgent.svg" -o "$appdir/usr/share/icons/hicolor/${size}x${size}/apps/org.quorum.ChairAgent.png"
done
cp "$appdir/usr/share/icons/hicolor/256x256/apps/org.quorum.ChairAgent.png" "$appdir/.DirIcon"
mkdir -p "$appdir/usr/share/fonts" "$appdir/THIRD_PARTY_NOTICES/system"
cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc "$appdir/usr/share/fonts/"
python3 scripts/appimage/bundle.py "$appdir"
# Carry licensing information for the actual Ubuntu dependencies and font.
dpkg-query -W -f='${binary:Package}\t${Version}\n' > "$appdir/BUILD-PACKAGES.txt"
for directory in /usr/share/doc/*; do
    if [ -f "$directory/copyright" ]; then cp "$directory/copyright" "$appdir/THIRD_PARTY_NOTICES/system/$(basename "$directory").copyright"; fi
done
cargo metadata --locked --format-version 1 --manifest-path packages/storage-agent-desktop/Cargo.toml > /tmp/cargo-metadata.json
python3 - "$appdir" <<'PY'
import json,shutil,sys
from pathlib import Path
root=Path(sys.argv[1])/'THIRD_PARTY_NOTICES/rust'; root.mkdir()
for item in json.load(open('/tmp/cargo-metadata.json'))['packages']:
 folder=Path(item['manifest_path']).parent
 target=root/(item['name']+'-'+item['version']); target.mkdir()
 (target/'metadata.json').write_text(json.dumps({k:item[k] for k in ['name','version','license','repository']},indent=2))
 for p in folder.iterdir():
  if p.is_file() and p.name.lower().startswith(('license','licence','copying','notice')): shutil.copy2(p,target/p.name)
PY
ARCH=x86_64 /opt/squashfs-root/AppRun --runtime-file /opt/appimage-runtime "$appdir" "/output/Quorum-Chair-Agent-$version-x86_64.AppImage"
tar -czf "/output/Quorum-Chair-Agent-$version-x86_64.tar.gz" -C "$(dirname "$appdir")" "$(basename "$appdir")"
cp "$appdir/ELF-DEPENDENCIES.json" /output/
cp "$appdir/BUILD-PACKAGES.txt" /output/
# Preserve the exact source used, including third-party Rust sources and lockfiles.
mkdir -p .cargo
cargo vendor --locked --manifest-path packages/storage-agent-desktop/Cargo.toml vendor > .cargo/config.toml
tar --exclude=./node_modules --exclude='*/node_modules' --exclude='*/target' --exclude='*/dist' --exclude=./release --exclude=./.git --exclude=./.tools -czf "/output/Quorum-Chair-Agent-$version-source.tar.gz" .
cd /output
sha256sum *.AppImage *.tar.gz > SHA256SUMS
