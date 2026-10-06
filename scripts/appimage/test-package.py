#!/usr/bin/env python3
"""Exercise the real launcher/registration in an isolated home, never the user's desktop."""
import fcntl, json, os, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

binary = Path(sys.argv[1]).resolve()
source = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='quorum-appimage-') as directory:
    root = Path(directory)
    home = root/'主席 home'; home.mkdir()
    hostbin = root/'hostbin'; hostbin.mkdir()
    for tool in ['update-desktop-database', 'update-mime-database', 'xdg-mime']:
        path = hostbin/tool; path.write_text('#!/bin/sh\nif [ "$(basename "$0")" = xdg-mime ]; then printf %s "${LD_LIBRARY_PATH-}" > "$HOME/host-library-path"; fi\nexit 0\n'); path.chmod(0o755)
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/'config'), XDG_DATA_HOME=str(home/'data'),
               PATH=str(hostbin)+':/usr/bin:/bin', QUORUM_APPIMAGE_ENV='1',
               QUORUM_HOST_PATH=str(hostbin)+':/usr/bin:/bin', LD_LIBRARY_PATH='/package-only', QUORUM_HOST_LD_LIBRARY_PATH='/host-only', QUORUM_AGENT_LAUNCHER=str(home/'100% 主席.AppImage'))
    subprocess.run([binary, '--register'], env=env, check=True)
    entry=home/'data/applications/org.quorum.ChairAgent.desktop'
    desktop=entry.read_text()
    assert str(home/'100%% 主席.AppImage') in desktop
    assert 'runtime/node' not in desktop and '.mount_' not in desktop
    assert 'Name[zh_CN]=Quorum 主席 Agent' in desktop
    assert (home/'host-library-path').read_text() == '/host-only'
    config=home/'config'; config.mkdir(exist_ok=True)
    associations=config/'mimeapps.list'
    associations.write_text('[Default Applications]\nx-scheme-handler/quorum-agent=org.quorum.ChairAgent.desktop;other.desktop;\n')
    sentinel=config/'keep.json'; sentinel.write_text('private-config-sentinel')
    subprocess.run([binary, '--unregister'], env=env, check=True)
    assert not entry.exists() and sentinel.read_text() == 'private-config-sentinel'
    assert 'other.desktop;' in associations.read_text() and 'org.quorum.ChairAgent.desktop' not in associations.read_text()
    # Run a harmless payload to inspect launch paths and exact forwarded arguments.
    appdir=root/'包 & with spaces'; appdir.mkdir()
    shutil.copy2(source/'AppRun', appdir/'AppRun')
    shutil.copy2(source/'prepare-fonts.cjs', appdir/'prepare-fonts.cjs')
    (appdir/'runtime').mkdir()
    (appdir/'runtime/node').symlink_to(shutil.which('node'))
    payload=appdir/'quorum-storage-agent-desktop'
    payload.write_text('#!/usr/bin/python3\nimport os,sys,json\nprint(json.dumps({"args":sys.argv[1:],"env":dict(os.environ)}))\n')
    payload.chmod(0o755)
    args=['--open', 'quorum-agent://pair#%中文&value=$literal']
    launch_env=dict(env, APPIMAGE=str(home/'100% 主席.AppImage'), LD_LIBRARY_PATH='/host-libraries')
    result=json.loads(subprocess.check_output([appdir/'AppRun', *args],env=launch_env,text=True))
    assert result['args']==args
    font_config=Path(result['env']['FONTCONFIG_FILE'])
    assert ET.parse(font_config).find('dir').text==str(appdir/'usr/share/fonts')
    assert result['env']['QUORUM_AGENT_NODE']==str(appdir/'runtime/node')
    assert result['env']['QUORUM_AGENT_LAUNCHER']==launch_env['APPIMAGE']
    assert result['env']['QUORUM_HOST_LD_LIBRARY_PATH']=='/host-libraries'
    assert result['env']['HOME']==str(home)
    # Installation must refuse while the existing instance holds the config lock.
    shutil.copy2(source/'install.sh', appdir/'install.sh')
    (appdir/'usr/bin').mkdir(parents=True)
    shutil.copy2(shutil.which('flock'),appdir/'usr/bin/flock')
    (config/'quorum-agent').mkdir(exist_ok=True)
    with (config/'quorum-agent/desktop.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        refused=subprocess.run([appdir/'AppRun','--install'],env=launch_env,capture_output=True,text=True)
        assert refused.returncode!=0 and 'Close Quorum' in refused.stderr
    install_env=dict(launch_env); install_env.pop('APPIMAGE')
    installed=json.loads(subprocess.check_output([appdir/'AppRun','--install'],env=install_env,text=True))
    destination=home/'data/quorum-agent/program/AppDir'
    assert installed['args']==['--register']
    assert installed['env']['QUORUM_AGENT_LAUNCHER']==str(destination/'AppRun')
    (destination/'obsolete-file').write_text('old program resource')
    subprocess.check_output([appdir/'AppRun','--install'],env=install_env,text=True)
    assert not (destination/'obsolete-file').exists(), 'Upgrade retained removed program files'
    assert sentinel.read_text()=='private-config-sentinel'
print('Launcher, desktop registration, unregister preservation and install lock checks passed.')
