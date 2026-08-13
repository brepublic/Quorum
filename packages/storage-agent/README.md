# Quorum Chair Storage Agent

This package contains the cross-platform filesystem and recovery core for `CHAIR_AGENT` storage. It is not yet a signed end-user distribution.

Build it from the repository root after sourcing `scripts/wsl-env.sh`:

```sh
pnpm --filter @quorum/storage-agent build
```

The CLI has two commands:

```sh
quorum-storage-agent pair --server https://quorum.example.com \
  --root /path/to/chosen-folder --config /path/to/private-agent.json \
  --pairing-code-file /path/to/private-one-time-code \
  --device-label "Chair computer"

quorum-storage-agent start --config /path/to/private-agent.json
```

The one-time code file and private config must be regular files accessible only to the current OS account. The config contains the device credential and private key. The selected directory's `.quorum-storage.json` contains no credential, private key, server URL, or absolute root path.
