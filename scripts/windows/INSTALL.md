# Quorum Chair Agent for Windows

Requires Windows 10 22H2 x64 (build 19045) or Windows 11 x64. Node.js and the
native directory-lock/credential helper are included. No developer tools or
administrator permissions are needed to run the Agent.

Run the `Setup.exe` release artifact for a per-user installation, Start Menu
shortcut, optional desktop shortcut, `quorum-agent:` protocol and
`.quorum-agent` connection-file association. Close the Agent before installing,
updating or uninstalling. Windows may ask before opening an external application.

The ZIP can be extracted into a stable directory and started using
`quorum-storage-agent-desktop.exe`. It does not register shortcuts or associations;
use the EXE installer for that integration. The command-line Agent is available
through `quorum-storage-agent.cmd` in the same directory.

Sign in with your Quorum website and choose a committee, or import a connection
file. For a local HTTPS server with a private CA, select its CA certificate in
the Agent's certificate settings. TLS verification remains enabled.

Private preferences and device credentials use `%LOCALAPPDATA%\quorum-agent`.
Meeting content uses the chosen folder, normally `Documents\Quorum`.
Uninstall removes program files and owned registration; it preserves credentials,
preferences and meeting content. A previous file-association choice is not
overridden, and registration changed to another application is not removed.

This release is unsigned. See `RELEASE.json` for pinned runtime and build details.
Quorum and Slint use GPL-3.0-only; `LICENSE.Quorum` and `THIRD_PARTY_NOTICES`
contain the corresponding notices. The accompanying source ZIP contains the
exact application source, lockfiles and Rust dependency source used for this build;
`SOURCE.json` identifies that archive and its SHA-256.

Windows 10 actual-machine acceptance remains pending when no Windows 10 test
environment is available. Building for that target does not constitute runtime
acceptance on Windows 10.
