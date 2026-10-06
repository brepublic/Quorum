#!/usr/bin/env python3
"""Collect Ubuntu-built ELF dependencies, including window libraries loaded at runtime."""
import json, os, re, shutil, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
libdir = root / 'usr/lib'
libdir.mkdir(parents=True, exist_ok=True)
# glibc/loader remain the target system's matched set. Never copy the build host's.
base = re.compile(r'^(ld-linux.*|lib(c|m|dl|pthread|rt|resolv|util|anl)\.so\..*)$')
queued = [root/'quorum-storage-agent-desktop', root/'runtime/node']
for name in ['flock', 'gdbus', 'update-desktop-database', 'update-mime-database']:
    target = root/'usr/bin'/name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(shutil.which(name), target)
    queued.append(target)
# winit, softbuffer and xkbcommon load these outside DT_NEEDED.
for name in ['libwayland-client.so.0', 'libwayland-cursor.so.0', 'libwayland-egl.so.1',
             'libxkbcommon.so.0', 'libxkbcommon-x11.so.0', 'libX11.so.6', 'libX11-xcb.so.1',
             'libXcursor.so.1', 'libXi.so.6', 'libXrandr.so.2', 'libXinerama.so.1',
             'libXrender.so.1', 'libXfixes.so.3', 'libxcb.so.1', 'libxcb-render.so.0',
             'libxcb-shape.so.0', 'libxcb-xfixes.so.0']:
    source = Path('/usr/lib/x86_64-linux-gnu')/name
    shutil.copy2(source, libdir/name)
    queued.append(libdir/name)
seen = set()
manifest = []
while queued:
    path = queued.pop()
    if path in seen: continue
    seen.add(path)
    versions = subprocess.check_output(['readelf', '--version-info', str(path)], text=True)
    required = [tuple(map(int, v.split('.'))) for v in re.findall(r'Name: GLIBC_([0-9.]+)', versions)]
    if required and max(required) > (2,35): raise SystemExit(f'{path}: exceeds GLIBC 2.35 baseline')
    deps = subprocess.check_output(['ldd', str(path)], text=True)
    if 'not found' in deps: raise SystemExit(f'Missing dependency: {path}\n{deps}')
    for name, source in re.findall(r'^\s*(\S+) => (/\S+)', deps, re.M):
        if base.match(name): continue
        target = libdir/name
        if not target.exists():
            shutil.copy2(source, target)
            queued.append(target)
    manifest.append({'file': str(path.relative_to(root)), 'glibc': '.'.join(map(str,max(required))) if required else None})
(root/'ELF-DEPENDENCIES.json').write_text(json.dumps(manifest, indent=2)+'\n')
