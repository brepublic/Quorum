#!/bin/sh
set -eu
umask 077
quorum_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
quorum_destination="${XDG_DATA_HOME:-$HOME/.local/share}/quorum-agent/program"
quorum_config="${XDG_CONFIG_HOME:-$HOME/.config}/quorum-agent"
mkdir -p "$quorum_config" "$quorum_destination"
exec 9>"$quorum_config/desktop.lock"
"$quorum_source/usr/bin/flock" --exclusive --nonblock 9 || { echo "Close Quorum Chair Agent before installing." >&2; exit 1; }
# Install only while the application is closed. Registration is explicit.
if [ -n "${APPIMAGE:-}" ]; then
    quorum_target="$quorum_destination/Quorum-Chair-Agent.AppImage"
    if [ "$APPIMAGE" != "$quorum_target" ]; then
        cp -- "$APPIMAGE" "$quorum_target.new"
        chmod 755 "$quorum_target.new"
        mv -f -- "$quorum_target.new" "$quorum_target"
    fi
    unset QUORUM_APPIMAGE_ENV
    exec "$quorum_target" --register
else
    if [ "$quorum_source" != "$quorum_destination/AppDir" ]; then
        quorum_staging=$(mktemp -d "$quorum_destination/.AppDir.XXXXXX")
        trap 'rm -rf "$quorum_staging"' EXIT HUP INT TERM
        cp -a "$quorum_source/." "$quorum_staging/"
        rm -rf "$quorum_destination/AppDir.previous"
        if [ -e "$quorum_destination/AppDir" ]; then mv "$quorum_destination/AppDir" "$quorum_destination/AppDir.previous"; fi
        mv "$quorum_staging" "$quorum_destination/AppDir"
        trap - EXIT HUP INT TERM
    fi
    exec "$quorum_destination/AppDir/AppRun" --register
fi
