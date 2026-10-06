# Quorum Chair Agent — Linux x86_64

Built on Ubuntu 22.04 (glibc 2.35 baseline). Requires a Linux desktop session
with X11 or Wayland, xdg-utils, and xdg-desktop-portal with the backend for that
desktop (for example xdg-desktop-portal-gnome or xdg-desktop-portal-kde).
Node, the Agent, file locking tools, client libraries and a Noto CJK fallback
font are included. No Node, Rust or Zenity installation is required.

## Run and install

Make the downloaded AppImage executable, then open it. To install its application
menu entry and pairing file/URL associations, close the Agent and run:

```sh
chmod +x Quorum-Chair-Agent-*-x86_64.AppImage
./Quorum-Chair-Agent-<version>-x86_64.AppImage --install
```

Installation is per user, without sudo, under
`$XDG_DATA_HOME/quorum-agent/program` (normally `~/.local/share/quorum-agent/program`).
Start **Quorum Chair Agent** from the application menu; pin it using your desktop's
normal controls. Desktop-file icons and AppImage thumbnails depend on the file
manager. No shortcut is automatically placed on the desktop.

If FUSE mounting is unavailable, use the `.tar.gz` archive, extract it in a
writable directory, and run `Quorum-Chair-Agent.AppDir/AppRun --install`.
`--appimage-extract-and-run` is also supported by the pinned runtime. Application
files and links must never point into a temporary extraction/mount directory.

## Upgrade and remove

Close the Agent before installing a new version with the same command. Restart
from the menu and confirm the existing committee reconnects. Keep the previous
package until verification is complete. Configuration schema changes, if any,
must be checked before attempting an older version.

Remove desktop integration using the installed AppImage with `--unregister`
(or `AppDir/AppRun --unregister` for the extracted installation), then remove the
program directory. Configuration remains in `$XDG_CONFIG_HOME/quorum-agent`
(normally `~/.config/quorum-agent`); meeting files remain in the selected storage
folder. Removing the application does not revoke the server's device credential.

## Desktop prerequisites and diagnostics

- A missing file chooser produces an error naming the portal requirement.
- Opening files requires a host application associated with their file type.
- A custom server CA must be selected in the Agent; development CA files are not
  distributed. TLS certificate verification stays enabled.
- Run from a terminal to see loader/startup failures that occur before the window.
- Linux containers can test loading and X11 with a virtual display; they do not
  certify a real Wayland desktop, input method, taskbar or browser activation.

GPLv3 source accompanies the release. `THIRD_PARTY_NOTICES`,
`BUILD-PACKAGES.txt` and `ELF-DEPENDENCIES.json` describe bundled dependencies.
