# Quorum Chair Storage Agent

This package is self-contained. Use the launcher beside this file; do not install Node.js or pnpm.

## Install and pair

Extract the complete archive into a versioned program directory owned by the current OS account:

- Windows: `%LOCALAPPDATA%\Quorum\StorageAgent\versions\0.1.0`
- macOS: `~/Library/Application Support/Quorum/StorageAgent/versions/0.1.0`

Keep the private config outside that versioned directory. A suitable location is
`%LOCALAPPDATA%\Quorum\StorageAgent\data\private-agent.json` on Windows or
`~/Library/Application Support/Quorum/StorageAgent/data/private-agent.json` on macOS.

Create the pairing-code file so only the current OS account can read it. Then run:

```text
quorum-storage-agent pair --server https://quorum.example.com --root <chosen-storage-directory> --config <private-config-path> --pairing-code-file <one-time-code-file> --device-label <label>
```

On Windows, invoke `quorum-storage-agent.cmd`. On macOS, invoke `./quorum-storage-agent`.
Delete the pairing-code file after pairing. Start the long-running process with:

```text
quorum-storage-agent start --config <private-config-path>
```

Use the same executable and config path for `status`.

## Upgrade

Stop the Agent, extract the new release into a new versioned program directory, verify its SHA-256 against
`SHA256SUMS`, and start it with the existing private config path. Do not move or rewrite the private config or
the chosen storage directory. This preserves the device identity, shared-directory metadata, pending uploads,
and conflict recovery state. Keep the preceding version until the new process has completed a sync cycle.

## Uninstall

Stop the Agent and remove only its versioned program directories. Do not remove the private config or the
chosen storage directory unless the committee has transferred or revoked the host and the data has been
retained elsewhere. Uninstalling never authorizes deleting user files.

Configure startup only after pairing. On Windows, create a current-user Task Scheduler entry that runs the
versioned `.cmd` launcher with `start --config <private-config-path>`. On macOS, create a user LaunchAgent with
the same arguments. Native startup, ACL, Gatekeeper, SmartScreen, and filesystem behavior must be verified on
the target operating system before distribution.
