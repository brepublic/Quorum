$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-env.ps1')

foreach ($quorumCommand in @('node', 'pnpm.cmd', 'rustc', 'cargo')) {
    & $quorumCommand --version
    if ($LASTEXITCODE -ne 0) { throw "$quorumCommand version check failed." }
}

$quorumCheck = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools/windows/toolchain-check'
New-Item -ItemType Directory -Force -Path $quorumCheck | Out-Null
$quorumSource = Join-Path $quorumCheck 'main.rs'
$quorumExecutable = Join-Path $quorumCheck 'toolchain-check.exe'
Set-Content -LiteralPath $quorumSource -Encoding utf8 -Value 'fn main() { println!("Windows Rust toolchain OK"); }'
& rustc --edition 2021 $quorumSource -o $quorumExecutable
if ($LASTEXITCODE -ne 0) { throw 'Rust native compile failed. Install Microsoft C++ Build Tools and a Windows SDK; see docs/self-hosted/CHAIR_AGENT_WINDOWS_SETUP.md.' }
& $quorumExecutable
if ($LASTEXITCODE -ne 0) { throw 'Rust native executable failed.' }
