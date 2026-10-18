// @vitest-environment node
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {archiveReleaseStage, materializeReleaseStage, readZip, sha256} from './storage-agent-release-lib.mjs';
import {inspectWindowsExecutable, verifyWindowsDesktopEntries} from './storage-agent-windows-release-lib.mjs';

function pe(subsystem: number, dependency = 'kernel32.dll') {
  const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94); const optional = 0x98; bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt16LE(subsystem, optional + 68); bytes.writeUInt32LE(0x1000, optional + 120);
  const section = optional + 240; bytes.writeUInt32LE(512, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x1080, 512 + 12); bytes.write(dependency, 640); return bytes;
}

function release() {
  const gui = pe(2); const helper = pe(3); const node = pe(3);
  const files: Record<string, Buffer | string> = {
    'quorum-storage-agent-desktop.exe': gui, 'quorum-agent-platform.exe': helper, 'runtime/node.exe': node,
    'app/cli.js': 'import fs from "node:fs";', 'app/desktop-bridge.js': 'import "./cli.js";', 'app/package.json': '{"type":"module"}',
    'quorum-storage-agent.cmd': 'set "QUORUM_AGENT_PLATFORM=%~dp0quorum-agent-platform.exe"\r\n"%~dp0runtime\\node.exe" "%~dp0app\\cli.js" %*\r\n',
    'INSTALL.md': 'install', 'LICENSE.Quorum': 'GPL', 'SOURCE.json': '{}', 'quorum-agent.ico': Buffer.from([0, 1]),
    'THIRD_PARTY_NOTICES/Node.js-LICENSE.txt': 'MIT', 'THIRD_PARTY_NOTICES/Inno-Setup-LICENSE.txt': 'Inno',
    'RELEASE.json': JSON.stringify({agentVersion: '0.1.0', nodeVersion: '22.23.2', target: 'win-x64', desktop: true,
      minimumWindowsVersion: '10.0.19045', crt: 'static', signed: false, runtimeSha256: sha256(node), nativeSha256: {gui: sha256(gui), platform: sha256(helper)}})
  };
  return Object.entries(files).map(([path, data]) => ({path: `bundle/${path}`, data: Buffer.from(data), mode: 0o100644}));
}
const target = {rootName: 'bundle', agentVersion: '0.1.0', nodeVersion: '22.23.2'};

describe('Windows desktop release boundary', () => {
  it('refuses a Windows package without the mandatory native lock helper', async () => {
    await expect(materializeReleaseStage({target: 'win-x64'})).rejects.toThrow('native platform helper');
  });
  it('recognizes x64 binaries and refuses a dependency on the VC redistributable', () => {
    expect(inspectWindowsExecutable(pe(2)).dependencies).toEqual(['kernel32.dll']);
    expect(() => inspectWindowsExecutable(Buffer.from('not a PE'))).toThrow('valid Windows x64');
    const entries = release(); const binary = entries.find(entry => entry.path.endsWith('quorum-agent-platform.exe'))!;
    binary.data = pe(3, 'VCRUNTIME140.dll');
    const metadata = entries.find(entry => entry.path.endsWith('RELEASE.json'))!;
    const value = JSON.parse(metadata.data.toString()); value.nativeSha256.platform = sha256(binary.data); metadata.data = Buffer.from(JSON.stringify(value));
    expect(() => verifyWindowsDesktopEntries(entries, target)).toThrow('unbundled DLL');
  });

  it('checks helpers, private-data exclusion, runtime integrity and bundled launcher paths', () => {
    expect(verifyWindowsDesktopEntries(release(), target).binaries['quorum-storage-agent-desktop.exe'].subsystem).toBe(2);
    expect(() => verifyWindowsDesktopEntries(release().filter(entry => !entry.path.endsWith('quorum-agent-platform.exe')), target)).toThrow('missing quorum-agent-platform');
    const privateData = [...release(), {path: 'bundle/private-agent.json', data: Buffer.from('credential'), mode: 0o100644}];
    expect(() => verifyWindowsDesktopEntries(privateData, target)).toThrow('Invalid Windows bundle entry');
    const changed = release(); changed.find(entry => entry.path === 'bundle/runtime/node.exe')!.data = Buffer.from('altered');
    expect(() => verifyWindowsDesktopEntries(changed, target)).toThrow('checksum mismatch');
    const launcher = release(); launcher.find(entry => entry.path.endsWith('.cmd'))!.data = Buffer.from('node app/cli.js');
    expect(() => verifyWindowsDesktopEntries(launcher, target)).toThrow('bundled paths');
    const foreign = release(); foreign.find(entry => entry.path === 'bundle/app/cli.js')!.data = Buffer.from('import thing from "other-package";');
    expect(() => verifyWindowsDesktopEntries(foreign, target)).toThrow('Unavailable Windows app dependency');
    const sideEffect = release(); sideEffect.find(entry => entry.path === 'bundle/app/cli.js')!.data = Buffer.from('import "other-package";');
    expect(() => verifyWindowsDesktopEntries(sideEffect, target)).toThrow('Unavailable Windows app dependency');
  });

  it('assigns archive permissions from the target even when the host filesystem differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-cross-release-'));
    try {
      const stage = join(root, 'stage'); await mkdir(join(stage, 'runtime'), {recursive: true});
      await writeFile(join(stage, 'runtime/node'), 'runtime', {mode: 0o644});
      await writeFile(join(stage, 'quorum-storage-agent'), 'launcher', {mode: 0o644});
      await writeFile(join(stage, 'README'), 'documentation', {mode: 0o755});
      await writeFile(join(stage, 'RELEASE.json'), '{"target":"linux-x64"}');
      const archive = join(root, 'linux.zip'); await archiveReleaseStage({stageDirectory: stage, outputPath: archive});
      const linux = readZip(await readFile(archive));
      expect(linux.find(entry => entry.path.endsWith('runtime/node'))!.mode).toBe(0o100755);
      expect(linux.find(entry => entry.path.endsWith('/README'))!.mode).toBe(0o100644);
      await writeFile(join(stage, 'RELEASE.json'), '{"target":"win-x64"}');
      const windowsArchive = join(root, 'windows.zip'); await archiveReleaseStage({stageDirectory: stage, outputPath: windowsArchive});
      expect(readZip(await readFile(windowsArchive)).every(entry => entry.mode === 0o100644)).toBe(true);
    } finally {await rm(root, {recursive: true, force: true});}
  });
});
