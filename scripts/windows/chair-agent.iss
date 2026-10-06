#ifndef StageDir
  #error StageDir is required
#endif
#ifndef ArtifactDir
  #error ArtifactDir is required
#endif
#ifndef AgentVersion
  #error AgentVersion is required
#endif

[Setup]
AppId={{E205128A-C3B2-438A-9CF6-41E096BD3C45}
AppName=Quorum Chair Agent
AppVersion={#AgentVersion}
AppPublisher=Quorum contributors
AppPublisherURL=https://github.com/brepublic/Quorum
DefaultDirName={localappdata}\Programs\Quorum Chair Agent
DefaultGroupName=Quorum Chair Agent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19045
OutputDir={#ArtifactDir}
OutputBaseFilename=Quorum-Chair-Agent-{#AgentVersion}-win-x64-Setup
SetupIconFile={#StageDir}\quorum-agent.ico
UninstallDisplayIcon={app}\quorum-storage-agent-desktop.exe
LicenseFile={#StageDir}\LICENSE.Quorum
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=yes
CloseApplications=yes
RestartApplications=no
Uninstallable=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Quorum Chair Agent"; Filename: "{app}\quorum-storage-agent-desktop.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall Quorum Chair Agent"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Quorum Chair Agent"; Filename: "{app}\quorum-storage-agent-desktop.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\quorum-agent"; ValueType: string; ValueName: ""; ValueData: "URL:Quorum Chair Agent Protocol"
Root: HKCU; Subkey: "Software\Classes\quorum-agent"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\quorum-agent\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\quorum-storage-agent-desktop.exe"",0"
Root: HKCU; Subkey: "Software\Classes\quorum-agent\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\quorum-storage-agent-desktop.exe"" --open ""%1"""
Root: HKCU; Subkey: "Software\Classes\org.quorum.ChairAgent.Pairing"; ValueType: string; ValueName: ""; ValueData: "Quorum Agent connection file"
Root: HKCU; Subkey: "Software\Classes\org.quorum.ChairAgent.Pairing\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\quorum-storage-agent-desktop.exe"",0"
Root: HKCU; Subkey: "Software\Classes\org.quorum.ChairAgent.Pairing\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\quorum-storage-agent-desktop.exe"" --open ""%1"""
Root: HKCU; Subkey: "Software\Classes\.quorum-agent\OpenWithProgids"; ValueType: string; ValueName: "org.quorum.ChairAgent.Pairing"; ValueData: ""
Root: HKCU; Subkey: "Software\Quorum\ChairAgent\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Quorum Chair Agent"
Root: HKCU; Subkey: "Software\Quorum\ChairAgent\Capabilities\FileAssociations"; ValueType: string; ValueName: ".quorum-agent"; ValueData: "org.quorum.ChairAgent.Pairing"
Root: HKCU; Subkey: "Software\Quorum\ChairAgent\Capabilities\URLAssociations"; ValueType: string; ValueName: "quorum-agent"; ValueData: "quorum-agent"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Quorum Chair Agent"; ValueData: "Software\Quorum\ChairAgent\Capabilities"

[Run]
Filename: "{app}\quorum-storage-agent-desktop.exe"; Description: "{cm:LaunchProgram,Quorum Chair Agent}"; Flags: nowait postinstall skipifsilent

[CustomMessages]
english.CloseAgent=Close Quorum Chair Agent before installing, updating or uninstalling.
chinesesimplified.CloseAgent=请先关闭 Quorum Chair Agent，再安装、更新或卸载。

[Code]
const
  InvalidHandle = $FFFFFFFF;
var
  AgentLock: THandle;

function CreateFileW(Name: String; Access, Sharing: LongWord; Security: Integer; Creation, Attributes: LongWord; Template: THandle): THandle;
external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
external 'CloseHandle@kernel32.dll stdcall';

procedure ReleaseAgentLock;
begin
  if AgentLock <> InvalidHandle then begin
    CloseHandle(AgentLock);
    AgentLock := InvalidHandle;
  end;
end;

function AcquireAgentLock: Boolean;
var LockPath: String;
begin
  AgentLock := InvalidHandle;
  LockPath := GetEnv('LOCALAPPDATA') + '\quorum-agent\desktop.lock';
  Result := True;
  if FileExists(LockPath) then begin
    AgentLock := CreateFileW(LockPath, $C0000000, 0, 0, 3, $00200000, 0);
    Result := AgentLock <> InvalidHandle;
    if not Result then
      SuppressibleMsgBox(CustomMessage('CloseAgent'), mbError, MB_OK, IDOK);
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := AcquireAgentLock;
end;

procedure DeinitializeSetup;
begin
  ReleaseAgentLock;
end;

function InitializeUninstall: Boolean;
begin
  Result := AcquireAgentLock;
end;

procedure DeinitializeUninstall;
begin
  ReleaseAgentLock;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Existing: String;
begin
  if CurStep = ssPostInstall then begin
    { Register a default only when there is no existing application choice. }
    if (not RegQueryStringValue(HKCU, 'Software\Classes\.quorum-agent', '', Existing)) or (Existing = '') then
      RegWriteStringValue(HKCU, 'Software\Classes\.quorum-agent', '', 'org.quorum.ChairAgent.Pairing');
    ReleaseAgentLock;
  end;
end;

function OwnsRegistration(Key: String): Boolean;
var Current, Expected: String;
begin
  Expected := '"' + ExpandConstant('{app}\quorum-storage-agent-desktop.exe') + '" --open "%1"';
  Result := RegQueryStringValue(HKCU, Key + '\shell\open\command', '', Current) and (CompareText(Current, Expected) = 0);
end;

procedure DeleteOwnedValue(Key, Name, Expected: String);
var Current: String;
begin
  if RegQueryStringValue(HKCU, Key, Name, Current) and (CompareText(Current, Expected) = 0) then
    RegDeleteValue(HKCU, Key, Name);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Current: String; OwnsProtocol, OwnsPairing: Boolean;
begin
  if CurUninstallStep = usUninstall then begin
    { Capture both ownership decisions before removing any registrations. }
    OwnsProtocol := OwnsRegistration('Software\Classes\quorum-agent');
    OwnsPairing := OwnsRegistration('Software\Classes\org.quorum.ChairAgent.Pairing');
    if OwnsProtocol then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\quorum-agent');
    if OwnsPairing then begin
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\org.quorum.ChairAgent.Pairing');
      DeleteOwnedValue('Software\Classes\.quorum-agent', '', 'org.quorum.ChairAgent.Pairing');
      DeleteOwnedValue('Software\Classes\.quorum-agent\OpenWithProgids', 'org.quorum.ChairAgent.Pairing', '');
      RegDeleteKeyIfEmpty(HKCU, 'Software\Classes\.quorum-agent\OpenWithProgids');
      RegDeleteKeyIfEmpty(HKCU, 'Software\Classes\.quorum-agent');
    end;
    if RegQueryStringValue(HKCU, 'Software\RegisteredApplications', 'Quorum Chair Agent', Current) and (Current = 'Software\Quorum\ChairAgent\Capabilities') then begin
      if OwnsPairing then begin
        DeleteOwnedValue('Software\Quorum\ChairAgent\Capabilities\FileAssociations', '.quorum-agent', 'org.quorum.ChairAgent.Pairing');
        RegDeleteKeyIfEmpty(HKCU, 'Software\Quorum\ChairAgent\Capabilities\FileAssociations');
      end;
      if OwnsProtocol then begin
        DeleteOwnedValue('Software\Quorum\ChairAgent\Capabilities\URLAssociations', 'quorum-agent', 'quorum-agent');
        RegDeleteKeyIfEmpty(HKCU, 'Software\Quorum\ChairAgent\Capabilities\URLAssociations');
      end;
      { A reassigned command still uses these capabilities and application entry. }
      if OwnsPairing and OwnsProtocol then begin
        RegDeleteValue(HKCU, 'Software\RegisteredApplications', 'Quorum Chair Agent');
        DeleteOwnedValue('Software\Quorum\ChairAgent\Capabilities', 'ApplicationName', 'Quorum Chair Agent');
        RegDeleteKeyIfEmpty(HKCU, 'Software\Quorum\ChairAgent\Capabilities');
        RegDeleteKeyIfEmpty(HKCU, 'Software\Quorum\ChairAgent');
        RegDeleteKeyIfEmpty(HKCU, 'Software\Quorum');
      end;
    end;
  end;
end;
