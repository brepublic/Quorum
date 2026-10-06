param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AgentArguments)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
. "$PSScriptRoot/windows-env.ps1"
pnpm --filter @quorum/contracts build
if ($LASTEXITCODE -ne 0) {throw 'Contracts build failed'}
pnpm --filter @quorum/storage-agent build
if ($LASTEXITCODE -ne 0) {throw 'Agent build failed'}
$env:QUORUM_AGENT_NODE = (Get-Command node.exe).Source
$env:QUORUM_AGENT_BRIDGE = Join-Path $PWD 'packages/storage-agent/dist/desktop-bridge.js'
cargo run --locked --manifest-path packages/storage-agent-desktop/Cargo.toml -- @AgentArguments
exit $LASTEXITCODE
