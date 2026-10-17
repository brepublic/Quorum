param(
    [Parameter(Mandatory = $true)][string]$Artifacts,
    [switch]$IncludeInstaller,
    [string]$Report
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -Force
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1" -Force
$quorumArtifacts = (Resolve-Path -LiteralPath $Artifacts).Path
if (-not $Report) { $Report = Join-Path $quorumArtifacts 'smoke-results.json' }
$quorumTemporary = Join-Path ([IO.Path]::GetTempPath()) ('Quorum Windows 验收 ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $quorumTemporary | Out-Null
$quorumResults = [Collections.Generic.List[object]]::new()
function Record-Check([string]$Name, [object]$Details) {
    $quorumResults.Add(@{ check = $Name; passed = $true; details = $Details })
    [IO.File]::WriteAllText($Report, ($quorumResults | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Write-Host "PASS: $Name"
}
function Wait-ProcessExit([Diagnostics.Process]$Process, [int]$Timeout = 15000) {
    if (-not $Process.WaitForExit($Timeout)) { $Process.Kill(); throw 'Packaged process did not stop within the timeout' }
    if ($Process.ExitCode -ne 0) { throw "Packaged process failed with exit $($Process.ExitCode) at smoke line $($MyInvocation.ScriptLineNumber) (PID $($Process.Id))" }
}
function Start-Redirected([string]$File, [string]$Arguments) {
    $quorumInfo = [Diagnostics.ProcessStartInfo]::new($File, $Arguments)
    $quorumInfo.UseShellExecute = $false; $quorumInfo.CreateNoWindow = $true
    $quorumInfo.RedirectStandardInput = $true; $quorumInfo.RedirectStandardOutput = $true; $quorumInfo.RedirectStandardError = $true
    return [Diagnostics.Process]::Start($quorumInfo)
}
function Read-ProcessLine([Diagnostics.Process]$Process) {
    $quorumRead = $Process.StandardOutput.ReadLineAsync()
    if (-not $quorumRead.Wait(10000)) { throw 'Packaged process did not respond within the timeout' }
    return $quorumRead.Result
}
$quorumOldPath = $env:PATH
$quorumOldLocal = $env:LOCALAPPDATA
$quorumOldNode = $env:QUORUM_AGENT_NODE
$quorumOldBridge = $env:QUORUM_AGENT_BRIDGE
$quorumOldPlatform = $env:QUORUM_AGENT_PLATFORM
$quorumBridgeProcess = $null; $quorumLockProcess = $null; $quorumGuiProcess = $null
try {
    $quorumManifest = Get-Content -LiteralPath (Join-Path $quorumArtifacts 'release-manifest.json') -Raw | ConvertFrom-Json
    foreach ($quorumArtifact in $quorumManifest.artifacts) {
        $quorumFile = Join-Path $quorumArtifacts $quorumArtifact.file
        if ((Get-FileHash -LiteralPath $quorumFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $quorumArtifact.sha256) { throw 'Release artifact checksum mismatch' }
    }
    Record-Check 'release artifact checksums' $quorumManifest.artifacts.file
    $quorumZip = Get-ChildItem -LiteralPath $quorumArtifacts -Filter '*-win-x64.zip'
    if (@($quorumZip).Count -ne 1) { throw 'Expected exactly one Windows binary ZIP' }
    Expand-Archive -LiteralPath $quorumZip.FullName -DestinationPath $quorumTemporary
    $quorumBundle = Join-Path $quorumTemporary $quorumZip.BaseName
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    $env:LOCALAPPDATA = Join-Path $quorumTemporary 'Private preferences'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
    Remove-Item Env:QUORUM_AGENT_NODE, Env:QUORUM_AGENT_BRIDGE, Env:QUORUM_AGENT_PLATFORM -ErrorAction SilentlyContinue
    $quorumNode = Join-Path $quorumBundle 'runtime/node.exe'
    $quorumRelease = Get-Content -LiteralPath (Join-Path $quorumBundle 'RELEASE.json') -Raw | ConvertFrom-Json
    if ((& $quorumNode --version) -ne "v$($quorumRelease.nodeVersion)") { throw 'Packaged Node version mismatch' }
    Record-Check 'bundled Node with isolated PATH' $quorumRelease.nodeVersion
    $quorumBridgeProcess = Start-Redirected $quorumNode ('"' + (Join-Path $quorumBundle 'app/desktop-bridge.js') + '"')
    $quorumBridgeRead = $quorumBridgeProcess.StandardOutput.ReadLineAsync()
    if (-not $quorumBridgeRead.Wait(10000)) { throw 'Packaged bridge did not respond' }
    if (-not $quorumBridgeRead.Result.StartsWith('{')) { throw 'Invalid packaged bridge response' }
    $quorumBridgeProcess.StandardInput.Close(); Wait-ProcessExit $quorumBridgeProcess
    Record-Check 'bundled bridge starts and exits on EOF' $true
    $quorumRoot = Join-Path $quorumTemporary 'Meeting 文件'
    New-Item -ItemType Directory -Path $quorumRoot | Out-Null
    $quorumHelper = Join-Path $quorumBundle 'quorum-agent-platform.exe'
    $quorumLockProcess = Start-Redirected $quorumHelper ('--lock-root "' + $quorumRoot + '"')
    if ((Read-ProcessLine $quorumLockProcess) -ne 'LOCKED') { throw 'Bundled helper failed to lock the folder' }
    $quorumOtherLock = Start-Redirected $quorumHelper ('--lock-root "' + $quorumRoot + '"')
    if ((Read-ProcessLine $quorumOtherLock) -ne 'AGENT_ALREADY_RUNNING') { throw 'Bundled helper allowed a second folder owner' }
    $quorumOtherLock.StandardInput.Close(); Wait-ProcessExit $quorumOtherLock
    $quorumLockProcess.StandardInput.Close(); Wait-ProcessExit $quorumLockProcess
    Record-Check 'bundled directory lock rejects concurrent owner and releases on EOF' $true
    $quorumGuiProcess = Start-Process -FilePath (Join-Path $quorumBundle 'quorum-storage-agent-desktop.exe') -WorkingDirectory $quorumBundle -PassThru
    $quorumDeadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200; $quorumGuiProcess.Refresh()
        if ($quorumGuiProcess.HasExited) { throw 'Packaged GUI exited before opening a window' }
    } while ($quorumGuiProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $quorumDeadline)
    if ($quorumGuiProcess.MainWindowHandle -eq 0) { throw 'Packaged GUI did not open a native window' }
    if (-not $quorumGuiProcess.WaitForInputIdle(10000)) { throw 'Packaged GUI did not become ready for window input' }
    $quorumGuiProcess.Refresh()
    if (-not $quorumGuiProcess.CloseMainWindow()) { throw 'Cannot request normal packaged GUI closure' }
    Wait-ProcessExit $quorumGuiProcess
    Record-Check 'ZIP GUI opens native window and closes normally' $true

    # Exercise a close request while the real GUI is waiting for its bridge.
    $quorumBusyBridge = Join-Path $quorumTemporary 'busy-bridge.cjs'
    $quorumBusyReady = Join-Path $quorumTemporary 'busy-ready'
    $quorumBusyResult = Join-Path $quorumTemporary 'busy-close-result'
    $quorumBusyScript = @'
const fs = require('node:fs');
let busy = true;
console.log(JSON.stringify({event:'busy',value:true}));
fs.writeFileSync(process.env.QUORUM_SMOKE_BUSY_READY, 'ready');
setTimeout(() => {busy=false; fs.writeFileSync(process.env.QUORUM_SMOKE_BUSY_READY, 'finished'); console.log(JSON.stringify({event:'busy',value:false}));}, 2000);
process.stdin.resume();
process.stdin.on('end', () => {fs.writeFileSync(process.env.QUORUM_SMOKE_BUSY_RESULT, busy ? 'early' : 'deferred'); process.exit(0);});
'@
    [IO.File]::WriteAllText($quorumBusyBridge, $quorumBusyScript, [Text.UTF8Encoding]::new($false))
    $env:QUORUM_AGENT_BRIDGE = $quorumBusyBridge
    $env:QUORUM_SMOKE_BUSY_READY = $quorumBusyReady
    $env:QUORUM_SMOKE_BUSY_RESULT = $quorumBusyResult
    try {
        $quorumGuiProcess = Start-Process -FilePath (Join-Path $quorumBundle 'quorum-storage-agent-desktop.exe') -WorkingDirectory $quorumBundle -PassThru
        $quorumDeadline = [DateTime]::UtcNow.AddSeconds(10)
        do { Start-Sleep -Milliseconds 100; $quorumGuiProcess.Refresh() }
        while ((-not (Test-Path -LiteralPath $quorumBusyReady) -or $quorumGuiProcess.MainWindowHandle -eq 0) -and [DateTime]::UtcNow -lt $quorumDeadline)
        if (-not (Test-Path -LiteralPath $quorumBusyReady) -or -not $quorumGuiProcess.WaitForInputIdle(10000)) { throw 'Busy GUI fixture did not become ready' }
        # Allow the 100 ms UI timer to consume busy=true, within the 2 s operation.
        Start-Sleep -Milliseconds 200
        $quorumGuiProcess.Refresh()
        if ([IO.File]::ReadAllText($quorumBusyReady) -ne 'ready') { throw 'Busy GUI fixture finished before the close request' }
        if (-not $quorumGuiProcess.CloseMainWindow()) { throw 'Cannot request busy GUI closure' }
        Wait-ProcessExit $quorumGuiProcess
        if ([IO.File]::ReadAllText($quorumBusyResult) -ne 'deferred') { throw 'GUI closed its bridge before the busy operation finished' }
        Record-Check 'busy GUI remembers one close request and waits for bridge cleanup' $true
    } finally {
        Remove-Item Env:QUORUM_AGENT_BRIDGE, Env:QUORUM_SMOKE_BUSY_READY, Env:QUORUM_SMOKE_BUSY_RESULT -ErrorAction SilentlyContinue
    }
    if ($IncludeInstaller) {
        $env:LOCALAPPDATA = $quorumOldLocal
        $quorumSetup = Get-ChildItem -LiteralPath $quorumArtifacts -Filter '*-Setup.exe'
        if (@($quorumSetup).Count -ne 1) { throw 'Expected exactly one setup executable' }
        $quorumInstall = Join-Path $quorumTemporary 'Installed program'
        $quorumConfig = Join-Path $env:LOCALAPPDATA 'quorum-agent'
        New-Item -ItemType Directory -Path $quorumConfig -Force | Out-Null
        $quorumSentinel = Join-Path $quorumConfig ('installer-preservation-' + [Guid]::NewGuid().ToString('N') + '.txt')
        [IO.File]::WriteAllText($quorumSentinel, 'preserve this private state')
        $quorumMeetingSentinel = Join-Path $quorumRoot 'preserve meeting.txt'
        [IO.File]::WriteAllText($quorumMeetingSentinel, 'preserve this meeting content')
        try {
            foreach ($quorumAttempt in 1..2) {
                $quorumInstallerLog = Join-Path $quorumArtifacts "installer-$quorumAttempt.log"
                $quorumInstallProcess = Start-Process -FilePath $quorumSetup.FullName -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=desktopicon',('/DIR="' + $quorumInstall + '"'),('/LOG="' + $quorumInstallerLog + '"')) -WindowStyle Hidden -PassThru
                Wait-ProcessExit $quorumInstallProcess 60000
            }
            $quorumExpected = '"' + (Join-Path $quorumInstall 'quorum-storage-agent-desktop.exe') + '" --open "%1"'
            foreach ($quorumKey in @('Registry::HKEY_CURRENT_USER\Software\Classes\quorum-agent\shell\open\command', 'Registry::HKEY_CURRENT_USER\Software\Classes\org.quorum.ChairAgent.Pairing\shell\open\command')) {
                if ((Get-Item -LiteralPath $quorumKey).GetValue('') -ne $quorumExpected) { throw 'Installer association command mismatch' }
            }
            Record-Check 'per-user install and repeated upgrade register bundled command' $true
            foreach ($quorumBinary in @('quorum-storage-agent-desktop.exe','quorum-agent-platform.exe','runtime/node.exe')) {
                if ((Get-FileHash -LiteralPath (Join-Path $quorumInstall $quorumBinary) -Algorithm SHA256).Hash -ne
                    (Get-FileHash -LiteralPath (Join-Path $quorumBundle $quorumBinary) -Algorithm SHA256).Hash) { throw 'Installed binary differs from the verified ZIP' }
            }
            $quorumStartMenuLink = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Quorum Chair Agent\Quorum Chair Agent.lnk'
            $quorumDesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Quorum Chair Agent.lnk'
            $quorumShell = New-Object -ComObject WScript.Shell
            foreach ($quorumLink in @($quorumStartMenuLink, $quorumDesktopLink)) {
                if (-not (Test-Path -LiteralPath $quorumLink) -or $quorumShell.CreateShortcut($quorumLink).TargetPath -ne (Join-Path $quorumInstall 'quorum-storage-agent-desktop.exe')) { throw 'Installed shortcut does not target the bundled GUI' }
            }
            Record-Check 'installer binary integrity and Start Menu/desktop shortcuts' $true
            $quorumGuiProcess = Start-Process -FilePath (Join-Path $quorumInstall 'quorum-storage-agent-desktop.exe') -WorkingDirectory $quorumInstall -PassThru
            $quorumDeadline = [DateTime]::UtcNow.AddSeconds(20)
            do {
                Start-Sleep -Milliseconds 200; $quorumGuiProcess.Refresh()
                if ($quorumGuiProcess.HasExited) { throw 'Installed GUI exited before opening a window' }
            } while ($quorumGuiProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $quorumDeadline)
            if ($quorumGuiProcess.MainWindowHandle -eq 0) { throw 'Installed GUI did not open a native window' }
            if (-not $quorumGuiProcess.WaitForInputIdle(10000)) { throw 'Installed GUI did not become ready for window input' }
            $quorumRunningUpdateLog = Join-Path $quorumArtifacts 'installer-running-update.log'
            $quorumRunningUpdate = Start-Process -FilePath $quorumSetup.FullName -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $quorumInstall + '"'),('/LOG="' + $quorumRunningUpdateLog + '"')) -WindowStyle Hidden -PassThru
            if (-not $quorumRunningUpdate.WaitForExit(15000)) { $quorumRunningUpdate.Kill(); throw 'Silent update while running failed to return' }
            if ($quorumRunningUpdate.ExitCode -eq 0 -or $quorumGuiProcess.HasExited) { throw 'Installer did not reject an update while the Agent was running' }
            Record-Check 'running Agent blocks silent update without terminating it' $true
            $quorumGuiProcess.Refresh()
            if (-not $quorumGuiProcess.CloseMainWindow()) { throw 'Cannot request normal installed GUI closure' }
            Wait-ProcessExit $quorumGuiProcess
            Record-Check 'installed GUI opens and closes normally with isolated PATH' $true
            $quorumUninstallLog = Join-Path $quorumArtifacts 'uninstall.log'
            $quorumUninstall = Start-Process -FilePath (Join-Path $quorumInstall 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="' + $quorumUninstallLog + '"')) -WindowStyle Hidden -PassThru
            Wait-ProcessExit $quorumUninstall 60000
            if (Test-Path -LiteralPath (Join-Path $quorumInstall 'quorum-storage-agent-desktop.exe')) { throw 'Uninstall retained the program binary' }
            if (-not (Test-Path -LiteralPath $quorumSentinel) -or -not (Test-Path -LiteralPath $quorumMeetingSentinel)) { throw 'Uninstall removed private or meeting data' }
            if (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Classes\quorum-agent\shell\open\command') { throw 'Uninstall retained the owned protocol' }
            if (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Classes\org.quorum.ChairAgent.Pairing\shell\open\command') { throw 'Uninstall retained the owned pairing file command' }
            if ((Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\RegisteredApplications').GetValue('Quorum Chair Agent')) { throw 'Uninstall retained owned application capabilities' }
            if ((Test-Path -LiteralPath $quorumStartMenuLink) -or (Test-Path -LiteralPath $quorumDesktopLink)) { throw 'Uninstall retained an owned shortcut' }
            Record-Check 'uninstall removes owned integration and preserves private and meeting data' $true

            # This branch runs only with -IncludeInstaller in an isolated user/Sandbox.
            $quorumExtensionKey = 'Registry::HKEY_CURRENT_USER\Software\Classes\.quorum-agent'
            New-Item -Path $quorumExtensionKey -Force | Out-Null
            Set-Item -LiteralPath $quorumExtensionKey -Value 'Quorum.Acceptance.Other'
            $quorumOtherOpenWith = Join-Path $quorumExtensionKey 'OpenWithProgids'
            New-Item -Path $quorumOtherOpenWith -Force | Out-Null
            New-ItemProperty -LiteralPath $quorumOtherOpenWith -Name 'Quorum.Acceptance.Other' -Value '' -PropertyType String -Force | Out-Null
            $quorumAssociationLog = Join-Path $quorumArtifacts 'installer-existing-associations.log'
            $quorumInstallProcess = Start-Process -FilePath $quorumSetup.FullName -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $quorumInstall + '"'),('/LOG="' + $quorumAssociationLog + '"')) -WindowStyle Hidden -PassThru
            Wait-ProcessExit $quorumInstallProcess 60000
            if ((Get-Item -LiteralPath $quorumExtensionKey).GetValue('') -ne 'Quorum.Acceptance.Other') { throw 'Installer replaced the existing file association choice' }
            if ((Get-Item -LiteralPath $quorumOtherOpenWith).GetValueNames() -notcontains 'Quorum.Acceptance.Other') { throw 'Installer removed the existing OpenWith provider' }
            Record-Check 'installer preserves an existing extension default and OpenWith provider' $true
            $quorumReassignedCommand = '"' + (Join-Path $env:SystemRoot 'System32\notepad.exe') + '" "%1"'
            foreach ($quorumKey in @('Registry::HKEY_CURRENT_USER\Software\Classes\quorum-agent\shell\open\command', 'Registry::HKEY_CURRENT_USER\Software\Classes\org.quorum.ChairAgent.Pairing\shell\open\command')) {
                Set-Item -LiteralPath $quorumKey -Value $quorumReassignedCommand
            }
            Set-Item -LiteralPath $quorumExtensionKey -Value 'org.quorum.ChairAgent.Pairing'
            $quorumReassignedLog = Join-Path $quorumArtifacts 'uninstall-reassigned-associations.log'
            $quorumUninstall = Start-Process -FilePath (Join-Path $quorumInstall 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="' + $quorumReassignedLog + '"')) -WindowStyle Hidden -PassThru
            Wait-ProcessExit $quorumUninstall 60000
            foreach ($quorumKey in @('Registry::HKEY_CURRENT_USER\Software\Classes\quorum-agent\shell\open\command', 'Registry::HKEY_CURRENT_USER\Software\Classes\org.quorum.ChairAgent.Pairing\shell\open\command')) {
                if ((Get-Item -LiteralPath $quorumKey).GetValue('') -ne $quorumReassignedCommand) { throw 'Uninstall removed a reassigned handler command' }
            }
            if ((Get-Item -LiteralPath $quorumExtensionKey).GetValue('') -ne 'org.quorum.ChairAgent.Pairing') { throw 'Uninstall removed the reassigned pairing default' }
            if ((Get-Item -LiteralPath $quorumOtherOpenWith).GetValueNames() -notcontains 'org.quorum.ChairAgent.Pairing') { throw 'Uninstall removed the reassigned pairing OpenWith entry' }
            if ((Get-Item -LiteralPath $quorumOtherOpenWith).GetValueNames() -notcontains 'Quorum.Acceptance.Other') { throw 'Uninstall removed an unrelated OpenWith provider' }
            if ((Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\RegisteredApplications').GetValue('Quorum Chair Agent') -ne 'Software\Quorum\ChairAgent\Capabilities') { throw 'Uninstall removed the reassigned registered application' }
            if ((Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Quorum\ChairAgent\Capabilities\FileAssociations').GetValue('.quorum-agent') -ne 'org.quorum.ChairAgent.Pairing') { throw 'Uninstall removed the reassigned file capability' }
            if ((Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Quorum\ChairAgent\Capabilities\URLAssociations').GetValue('quorum-agent') -ne 'quorum-agent') { throw 'Uninstall removed the reassigned protocol capability' }
            if (Test-Path -LiteralPath (Join-Path $quorumInstall 'quorum-storage-agent-desktop.exe')) { throw 'Reassigned associations prevented removal of owned program files' }
            Record-Check 'uninstall preserves reassigned commands/default/OpenWith/registered capabilities' $true
        } finally { if (Test-Path -LiteralPath $quorumSentinel) {Remove-Item -LiteralPath $quorumSentinel} }
    }
} catch {
    Write-Host $_.ScriptStackTrace
    $quorumResults.Add(@{check = 'smoke failure'; passed = $false; details = $_.Exception.Message})
    [IO.File]::WriteAllText($Report, ($quorumResults | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    throw
} finally {
    foreach ($quorumProcess in @($quorumBridgeProcess, $quorumLockProcess, $quorumGuiProcess)) { if ($null -ne $quorumProcess -and -not $quorumProcess.HasExited) { $quorumProcess.Kill() } }
    $env:PATH = $quorumOldPath; $env:LOCALAPPDATA = $quorumOldLocal
    $env:QUORUM_AGENT_NODE = $quorumOldNode; $env:QUORUM_AGENT_BRIDGE = $quorumOldBridge; $env:QUORUM_AGENT_PLATFORM = $quorumOldPlatform
    if (([IO.Path]::GetFullPath($quorumTemporary)).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $quorumTemporary -Recurse -Force
    }
}
