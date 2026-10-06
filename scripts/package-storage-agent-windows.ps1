param(
    [switch]$Offline,
    [switch]$UseSystemTools,
    [string]$Output = 'release/windows',
    [string]$RuntimeCache = '.tools/downloads',
    [string]$InnoDirectory = '.tools/windows/innosetup'
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -Force
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -Force
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $UseSystemTools) { . "$PSScriptRoot/windows-env.ps1" }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'The Windows release requires an x64 Windows build host' }
$quorumLock = Get-Content -LiteralPath "$PSScriptRoot/windows/toolchain-lock.json" -Raw | ConvertFrom-Json
$quorumRuntimeLock = Get-Content -LiteralPath "$PSScriptRoot/storage-agent-runtime-lock.json" -Raw | ConvertFrom-Json
if ((& node --version) -ne "v$($quorumRuntimeLock.nodeVersion)") { throw 'Use the pinned Node runtime' }
if ((& rustc --version) -notlike "rustc $($quorumLock.rustVersion) *") { throw 'Use the pinned Rust toolchain' }
$quorumInno = Join-Path $PWD $InnoDirectory
if (-not (Test-Path -LiteralPath (Join-Path $quorumInno 'ISCC.exe'))) {
    if ($Offline) { throw 'The pinned Inno compiler is not cached' }
    $quorumDownload = Join-Path $PWD '.tools/downloads/innosetup-6.7.3.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $quorumDownload) -Force | Out-Null
    Invoke-WebRequest -Uri $quorumLock.innoSetup.url -OutFile $quorumDownload
    if ((Get-FileHash -LiteralPath $quorumDownload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $quorumLock.innoSetup.sha256) { throw 'Inno compiler checksum mismatch' }
    $quorumSignature = Get-AuthenticodeSignature -LiteralPath $quorumDownload
    if ($quorumSignature.Status -ne 'Valid' -or $quorumSignature.SignerCertificate.Subject -notlike '*Pyrsys B.V.*') { throw 'Inno compiler publisher verification failed' }
    $quorumInstaller = Start-Process -FilePath $quorumDownload -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', ('/DIR="' + $quorumInno + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($quorumInstaller.ExitCode -ne 0) { throw 'Inno compiler installation failed' }
}
foreach ($quorumCompilerFile in $quorumLock.innoSetup.compilerFiles.PSObject.Properties) {
    if ((Get-FileHash -LiteralPath (Join-Path $quorumInno $quorumCompilerFile.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $quorumCompilerFile.Value) { throw 'Inno compiler does not match the tool lock' }
}
pnpm --filter @quorum/contracts build
if ($LASTEXITCODE -ne 0) { throw 'Contracts build failed' }
pnpm --filter @quorum/storage-agent build
if ($LASTEXITCODE -ne 0) { throw 'Agent build failed' }
$quorumPreviousRustFlags = $env:RUSTFLAGS
try {
    $env:RUSTFLAGS = '-C target-feature=+crt-static'
    cargo build --release --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --bins
    if ($LASTEXITCODE -ne 0) { throw 'Native Windows release build failed' }
} finally { $env:RUSTFLAGS = $quorumPreviousRustFlags }
New-Item -ItemType Directory -Path '.tools/windows' -Force | Out-Null
cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --manifest-path packages/storage-agent-desktop/Cargo.toml | Set-Content -LiteralPath '.tools/windows/cargo-metadata-release.json' -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Cargo dependency metadata failed' }
$quorumArguments = @('scripts/build-storage-agent-windows.mjs', '--output', $Output, '--runtime-cache', $RuntimeCache, '--inno-dir', $InnoDirectory)
if ($Offline) { $quorumArguments += '--offline' }
node @quorumArguments
if ($LASTEXITCODE -ne 0) { throw 'Windows bundle or installer verification failed' }
