import {sha256} from './storage-agent-release-lib.mjs';

const systemDlls = new Set(['kernel32.dll', 'ntdll.dll', 'dwrite.dll', 'user32.dll', 'dwmapi.dll', 'gdi32.dll',
  'comctl32.dll', 'shell32.dll', 'shlwapi.dll', 'oleaut32.dll', 'combase.dll', 'advapi32.dll', 'uxtheme.dll',
  'bcryptprimitives.dll', 'imm32.dll', 'ole32.dll', 'dbghelp.dll', 'ws2_32.dll', 'crypt32.dll', 'iphlpapi.dll',
  'userenv.dll', 'winmm.dll', 'bcrypt.dll', 'normaliz.dll']);

export function inspectWindowsExecutable(data) {
  try {
    if (data.readUInt16LE(0) !== 0x5a4d) throw new Error();
    const pe = data.readUInt32LE(0x3c);
    if (data.readUInt32LE(pe) !== 0x4550 || data.readUInt16LE(pe + 4) !== 0x8664) throw new Error();
    const sectionCount = data.readUInt16LE(pe + 6); const headerSize = data.readUInt16LE(pe + 20);
    const optional = pe + 24;
    if (data.readUInt16LE(optional) !== 0x20b) throw new Error();
    const sections = [];
    for (let index = 0; index < sectionCount; index++) {
      const offset = optional + headerSize + index * 40;
      sections.push({rva: data.readUInt32LE(offset + 12), size: Math.max(data.readUInt32LE(offset + 8), data.readUInt32LE(offset + 16)),
        raw: data.readUInt32LE(offset + 20)});
    }
    const fileOffset = rva => {
      const section = sections.find(item => rva >= item.rva && rva < item.rva + item.size);
      if (!section) throw new Error(); return section.raw + rva - section.rva;
    };
    const dependencies = [];
    const importRva = data.readUInt32LE(optional + 120);
    if (importRva) {
      let offset = fileOffset(importRva);
      for (let index = 0; index < 1024; index++, offset += 20) {
        const nameRva = data.readUInt32LE(offset + 12);
        if (!nameRva) break;
        const nameOffset = fileOffset(nameRva); const end = data.indexOf(0, nameOffset);
        if (end < nameOffset || end - nameOffset > 260) throw new Error();
        dependencies.push(data.subarray(nameOffset, end).toString('ascii').toLowerCase());
      }
    }
    return {machine: 'AMD64', subsystem: data.readUInt16LE(optional + 68), dependencies: [...new Set(dependencies)].sort()};
  } catch {throw new Error('Expected a valid Windows x64 PE executable');}
}

export function verifyWindowsDesktopEntries(entries, {rootName, agentVersion, nodeVersion, forbiddenValues = []}) {
  const prefix = `${rootName}/`;
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('Duplicate Windows release entry');
  const paths = new Map(entries.map(entry => [entry.path.slice(prefix.length), entry]));
  const required = ['quorum-storage-agent-desktop.exe', 'quorum-agent-platform.exe', 'runtime/node.exe', 'app/cli.js', 'app/desktop-bridge.js',
    'app/package.json', 'quorum-storage-agent.cmd', 'INSTALL.md', 'LICENSE.Quorum', 'SOURCE.json', 'RELEASE.json', 'quorum-agent.ico',
    'THIRD_PARTY_NOTICES/Node.js-LICENSE.txt', 'THIRD_PARTY_NOTICES/Inno-Setup-LICENSE.txt'];
  for (const name of required) if (!paths.has(name)) throw new Error(`Windows bundle is missing ${name}`);
  const exact = new Set(required);
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length);
    if (!entry.path.startsWith(prefix) || entry.mode !== 0o100644 || (!exact.has(path) && !/^app\/[a-z0-9-]+\.js$/.test(path)
      && !/^THIRD_PARTY_NOTICES\/rust\/[a-zA-Z0-9_.+-]+\/[a-zA-Z0-9_.+-]+$/.test(path))) throw new Error(`Invalid Windows bundle entry: ${path}`);
    if (/\.(?:exe|ico)$/.test(path)) continue;
    for (const forbidden of forbiddenValues.filter(Boolean)) if (entry.data.toString().includes(forbidden)) throw new Error(`Windows bundle includes a forbidden local value: ${path}`);
  }
  const metadata = JSON.parse(paths.get('RELEASE.json').data.toString());
  if (metadata.agentVersion !== agentVersion || metadata.nodeVersion !== nodeVersion || metadata.target !== 'win-x64' ||
      metadata.desktop !== true || metadata.minimumWindowsVersion !== '10.0.19045' || metadata.crt !== 'static' || metadata.signed !== false) throw new Error('Windows release metadata does not match the locked target');
  if (sha256(paths.get('runtime/node.exe').data) !== metadata.runtimeSha256 ||
      sha256(paths.get('quorum-storage-agent-desktop.exe').data) !== metadata.nativeSha256.gui ||
      sha256(paths.get('quorum-agent-platform.exe').data) !== metadata.nativeSha256.platform) throw new Error('Windows executable checksum mismatch');
  const launcher = paths.get('quorum-storage-agent.cmd').data.toString();
  if (!launcher.includes('set "QUORUM_AGENT_PLATFORM=%~dp0quorum-agent-platform.exe"') ||
      !launcher.includes('"%~dp0runtime\\node.exe" "%~dp0app\\cli.js" %*')) throw new Error('Windows CLI launcher does not use bundled paths');
  const appFiles = new Set([...paths.keys()].filter(name => name.startsWith('app/')));
  for (const [path, entry] of paths) {
    if (!/^app\/[a-z0-9-]+\.js$/.test(path)) continue;
    for (const match of entry.data.toString().matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('node:') && (!match[1].startsWith('./') || !appFiles.has(`app/${match[1].slice(2)}`))) throw new Error(`Unavailable Windows app dependency: ${match[1]}`);
    }
  }
  const binaries = {};
  for (const name of ['quorum-storage-agent-desktop.exe', 'quorum-agent-platform.exe', 'runtime/node.exe']) {
    const pe = inspectWindowsExecutable(paths.get(name).data);
    if (pe.subsystem !== (name === 'quorum-storage-agent-desktop.exe' ? 2 : 3)) throw new Error(`Unexpected Windows executable subsystem: ${name}`);
    for (const dependency of pe.dependencies) if (!systemDlls.has(dependency) && !/^api-ms-win-[a-z0-9-]+\.dll$/.test(dependency)) throw new Error(`Windows executable needs an unbundled DLL: ${dependency}`);
    binaries[name] = pe;
  }
  return {metadata, binaries};
}
