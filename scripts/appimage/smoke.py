#!/usr/bin/env python3
"""Run the packaged executable with a fresh home and virtual X11 desktop."""
import os, signal, subprocess, sys, tempfile, time
from pathlib import Path
artifact=Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='quorum-package-smoke-') as directory:
    root=Path(directory)
    env=dict(os.environ, HOME=str(root), XDG_CONFIG_HOME=str(root/'config'),
             XDG_DATA_HOME=str(root/'data'), DISPLAY=':97', APPIMAGE_EXTRACT_AND_RUN='1')
    for name in ['QUORUM_AGENT_NODE','QUORUM_AGENT_BRIDGE','QUORUM_AGENT_LAUNCHER','WAYLAND_DISPLAY']:
        env.pop(name,None)
    display=subprocess.Popen(['Xvfb',':97','-screen','0','1024x768x24'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    process=None
    try:
        time.sleep(1)
        assert display.poll() is None, 'Virtual display failed'
        with (root/'startup.log').open('w+') as log:
            process=subprocess.Popen(['dbus-run-session','--',str(artifact)],env=env,stdout=log,stderr=log,start_new_session=True)
            time.sleep(5)
            if process.poll() is not None:
                log.seek(0); raise AssertionError('Packaged GUI exited early: '+log.read())
            assert (root/'config/quorum-agent/desktop.sock').exists(), 'GUI instance did not initialize'
            bridges=[]
            for proc in Path('/proc').glob('[0-9]*/cmdline'):
                try:
                    args=proc.read_bytes().split(b'\0')
                    if len(args)>1 and args[0].endswith(b'/runtime/node') and args[1].endswith(b'/app/desktop-bridge.js'):
                        bridges.append(args)
                except (FileNotFoundError, PermissionError):
                    pass
            assert len(bridges)==1, 'Bundled Node bridge did not stay running'
            assert not (root/'data/applications/org.quorum.ChairAgent.desktop').exists(), 'Normal startup registered a desktop entry'
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            process.wait(timeout=10)
        display.terminate(); display.wait(timeout=10)
    # Verify the CJK fallback without relying on fonts installed on the build machine.
    subprocess.run([str(artifact),'--appimage-extract'],cwd=root,env=env,stdout=subprocess.DEVNULL,check=True)
    extracted=root/'squashfs-root'
    font_check = r"""
import ctypes as c, sys
from pathlib import Path
root=Path(sys.argv[1])
f=c.CDLL(str(root/'usr/lib/libfontconfig.so.1'))
f.FcInitLoadConfigAndFonts.restype=c.c_void_p
f.FcNameParse.argtypes=[c.c_char_p]; f.FcNameParse.restype=c.c_void_p
f.FcConfigSubstitute.argtypes=[c.c_void_p,c.c_void_p,c.c_int]
f.FcDefaultSubstitute.argtypes=[c.c_void_p]
f.FcFontMatch.argtypes=[c.c_void_p,c.c_void_p,c.POINTER(c.c_int)]; f.FcFontMatch.restype=c.c_void_p
f.FcPatternGetString.argtypes=[c.c_void_p,c.c_char_p,c.c_int,c.POINTER(c.c_char_p)]
config=f.FcInitLoadConfigAndFonts(); pattern=f.FcNameParse(b'sans-serif:lang=zh-cn')
f.FcConfigSubstitute(config,pattern,0); f.FcDefaultSubstitute(pattern)
result=c.c_int(); match=f.FcFontMatch(config,pattern,c.byref(result)); path=c.c_char_p()
assert match and f.FcPatternGetString(match,b'file',0,c.byref(path)) == 0
assert Path(path.value.decode()).is_relative_to(root/'usr/share/fonts'), path.value
print('Bundled CJK font selected with no system CJK fonts.')
"""
    font_config=subprocess.check_output([extracted/'runtime/node',extracted/'prepare-fonts.cjs',extracted],env=env,text=True).strip()
    subprocess.run([sys.executable,'-c',font_check,str(extracted)],
        env=dict(env,LD_LIBRARY_PATH=str(extracted/'usr/lib'),FONTCONFIG_FILE=font_config),check=True)
    subprocess.run([str(artifact),'--install'],env=env,check=True)
    installed=root/'data/quorum-agent/program/Quorum-Chair-Agent.AppImage'
    entry=root/'data/applications/org.quorum.ChairAgent.desktop'
    assert installed.exists() and str(installed) in entry.read_text()
    assert '.mount_' not in entry.read_text() and 'appimage_extracted' not in entry.read_text()
    handler=subprocess.check_output(['xdg-mime','query','default','application/x-quorum-agent-pairing'],env=env,text=True).strip()
    assert handler=='org.quorum.ChairAgent.desktop', handler
    sentinel=root/'config/quorum-agent/keep.json'; sentinel.write_text('keep')
    subprocess.run([str(installed),'--unregister'],env=env,check=True)
    assert not entry.exists() and sentinel.read_text()=='keep'
print('Packaged GUI, explicit install, real MIME registration and unregister passed on clean Ubuntu X11.')
