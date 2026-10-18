# Dot-source from PowerShell: . .\scripts\windows-env.ps1
# Official Windows tools are installed in this checkout's ignored .tools directory.
$quorumRoot = Split-Path -Parent $PSScriptRoot
$quorumRuntime = Get-Content -LiteralPath (Join-Path $quorumRoot 'scripts/storage-agent-runtime-lock.json') -Raw | ConvertFrom-Json
$quorumNode = Join-Path $quorumRoot ".tools/node-windows/node-v$($quorumRuntime.nodeVersion)-win-x64"
$quorumPnpm = Join-Path $quorumRoot '.tools/windows/pnpm'
$quorumCargo = Join-Path $quorumRoot '.tools/windows/cargo'
$quorumRustup = Join-Path $quorumRoot '.tools/windows/rustup'

foreach ($quorumTool in @((Join-Path $quorumNode 'node.exe'), (Join-Path $quorumPnpm 'pnpm.cmd'), (Join-Path $quorumCargo 'bin/cargo.exe'))) {
    if (-not (Test-Path -LiteralPath $quorumTool -PathType Leaf)) {
        throw "Missing Windows tool: $quorumTool. See docs/self-hosted/CHAIR_AGENT_WINDOWS_SETUP.md."
    }
}
$env:CARGO_HOME = $quorumCargo
$env:RUSTUP_HOME = $quorumRustup
$env:npm_config_cache = Join-Path $quorumRoot '.tools/windows/npm-cache'
$quorumPaths = @($quorumNode, $quorumPnpm, (Join-Path $quorumCargo 'bin'))
$env:PATH = (($quorumPaths + @($env:PATH -split ';' | Where-Object { $_ -and $_ -notin $quorumPaths })) -join ';')
Remove-Variable quorumRoot, quorumRuntime, quorumNode, quorumPnpm, quorumCargo, quorumRustup, quorumTool, quorumPaths
