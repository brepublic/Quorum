import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {deflateRawSync, gunzipSync, gzipSync, inflateRawSync} from 'node:zlib';

const FIXED_MODE_FILE = 0o100644;
const FIXED_MODE_EXECUTABLE = 0o100755;
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const comparePath = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const crcTable = Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipPath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return path;
}

export function createDeterministicZip(entries) {
  const localParts = []; const centralParts = []; let offset = 0;
  const sorted = [...entries].sort((left, right) => comparePath(left.path, right.path));
  for (const entry of sorted) {
    const name = Buffer.from(zipPath(entry.path)); const data = Buffer.from(entry.data); const crc = crc32(data);
    const deflated = deflateRawSync(data, {level: 9}); const compressed = deflated.length < data.length ? deflated : data;
    const method = compressed === data ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((entry.mode ?? FIXED_MODE_FILE) & 0xffff) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts); const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

export function readZip(value) {
  const buffer = Buffer.from(value); const entries = [];
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('ZIP end record is missing.');
  const count = buffer.readUInt16LE(endOffset + 10); let offset = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL) throw new Error('ZIP central record is invalid.');
    const method = buffer.readUInt16LE(offset + 10); const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20); const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32); const external = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42); const rawPath = buffer.subarray(offset + 46, offset + 46 + nameLength).toString();
    const directory = rawPath.endsWith('/'); const path = zipPath(directory ? rawPath.slice(0, -1) : rawPath);
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) throw new Error('ZIP local record is invalid.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26); const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength; const compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!data || data.length !== size || crc32(data) !== crc) throw new Error(`ZIP entry failed validation: ${path}`);
    if (!directory) entries.push({path, data, mode: (external >>> 16) & 0xffff});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function tarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  header.write(encoded, offset, length - 1, 'ascii'); header[offset + length - 1] = 0;
}

function tarHeader(path, size, mode) {
  const name = Buffer.from(zipPath(path));
  if (name.length > 100) throw new Error(`TAR path is too long: ${path}`);
  const header = Buffer.alloc(512); name.copy(header, 0);
  tarOctal(header, 100, 8, mode & 0o7777); tarOctal(header, 108, 8, 0); tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size); tarOctal(header, 136, 12, 0); header.fill(0x20, 148, 156);
  header[156] = 0x30; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 4, 'ascii'); header.write('root', 297, 4, 'ascii');
  let checksum = 0; for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8).padStart(6, '0'); header.write(encoded, 148, 6, 'ascii'); header[154] = 0; header[155] = 0x20;
  return header;
}

export function createDeterministicTarGz(entries) {
  const parts = [];
  for (const entry of [...entries].sort((left, right) => comparePath(left.path, right.path))) {
    const data = Buffer.from(entry.data); parts.push(tarHeader(entry.path, data.length, entry.mode ?? FIXED_MODE_FILE), data);
    const padding = (512 - (data.length % 512)) % 512; if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(parts), {level: 9, mtime: 0}); archive[9] = 0xff; return archive;
}

export function readTarGz(value) {
  const buffer = gunzipSync(value); const entries = []; let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const rawPath = header.subarray(0, 100).toString().replace(/\0.*$/, ''); const type = header[156];
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8);
    const mode = Number.parseInt(header.subarray(100, 108).toString().replace(/\0.*$/, '').trim() || '0', 8);
    const dataStart = offset + 512; const data = Buffer.from(buffer.subarray(dataStart, dataStart + size));
    if (data.length !== size) throw new Error(`TAR entry is truncated: ${rawPath}`);
    if ([0x4b, 0x4c, 0x67, 0x78].includes(type)) {
      offset = dataStart + Math.ceil(size / 512) * 512; continue;
    }
    const directory = type === 0x35 || rawPath.endsWith('/');
    const path = zipPath(directory && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath);
    if (directory) { /* directory entries are not materialized */ }
    else if (type === 0 || type === 0x30) entries.push({path, data, mode});
    else if (type !== 0x32) throw new Error(`Unsupported TAR entry type: ${path}`);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function runtimeFilesFromArchive(target, archiveName, value) {
  const root = archiveName.replace(/\.tar\.gz$|\.zip$/g, '');
  const entries = archiveName.endsWith('.zip') ? readZip(value) : readTarGz(value);
  const runtimeSuffix = target.startsWith('win-') ? '/node.exe' : '/bin/node';
  const runtime = entries.find(entry => entry.path === `${root}${runtimeSuffix}`);
  const license = entries.find(entry => entry.path === `${root}/LICENSE`);
  if (!runtime || !license) throw new Error(`Pinned runtime archive is incomplete for ${target}.`);
  return {runtime: runtime.data, license: license.data};
}

export async function downloadPinnedArchive({url, destination, expectedSha256, offline = false}) {
  await mkdir(dirname(destination), {recursive: true});
  try {
    if (await sha256File(destination) === expectedSha256) return destination;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (offline) throw new Error(`Pinned runtime is not cached: ${basename(destination)}`);
  await rm(destination, {force: true});
  const response = await fetch(url, {redirect: 'error'});
  if (!response.ok || !response.body) throw new Error(`Runtime download failed with HTTP ${response.status}.`);
  const temporary = `${destination}.partial-${process.pid}`; const hash = createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) { hash.update(chunk); yield chunk; }
    }, createWriteStream(temporary, {mode: 0o600}));
    if (hash.digest('hex') !== expectedSha256) throw new Error(`Runtime checksum mismatch: ${basename(destination)}`);
    await rename(temporary, destination);
  } finally { await rm(temporary, {force: true}); }
  return destination;
}

export async function collectStageEntries(stageDirectory) {
  const root = resolve(stageDirectory); const entries = [];
  async function visit(directory) {
    for (const item of (await readdir(directory, {withFileTypes: true})).sort((a, b) => comparePath(a.name, b.name))) {
      const absolute = join(directory, item.name); const info = await stat(absolute);
      if (item.isSymbolicLink() || !item.isFile() && !item.isDirectory()) throw new Error(`Release stage contains an unsafe file: ${absolute}`);
      if (item.isDirectory()) await visit(absolute);
      else entries.push({path: absolute.slice(root.length + 1).split(sep).join('/'), data: await readFile(absolute), mode: info.mode & 0o111 ? FIXED_MODE_EXECUTABLE : FIXED_MODE_FILE});
    }
  }
  await visit(root); return entries;
}

export async function materializeReleaseStage({rootDirectory, distDirectory, releaseReadmePath, target, agentVersion, nodeVersion, runtime, license}) {
  await rm(rootDirectory, {recursive: true, force: true}); await mkdir(join(rootDirectory, 'app'), {recursive: true});
  const jsFiles = (await readdir(distDirectory)).filter(name => name.endsWith('.js')).sort();
  if (!jsFiles.includes('cli.js')) throw new Error('Storage Agent dist/cli.js is missing.');
  for (const name of jsFiles) await copyFile(join(distDirectory, name), join(rootDirectory, 'app', name));
  await writeFile(join(rootDirectory, 'app', 'package.json'), '{"type":"module"}\n', {mode: 0o644});
  const runtimeName = target.startsWith('win-') ? 'node.exe' : 'node';
  await mkdir(join(rootDirectory, 'runtime'), {recursive: true});
  await writeFile(join(rootDirectory, 'runtime', runtimeName), runtime, {mode: target.startsWith('win-') ? 0o644 : 0o755});
  await mkdir(join(rootDirectory, 'THIRD_PARTY_NOTICES'), {recursive: true});
  await writeFile(join(rootDirectory, 'THIRD_PARTY_NOTICES', 'Node.js-LICENSE.txt'), license, {mode: 0o644});
  await copyFile(releaseReadmePath, join(rootDirectory, 'INSTALL.md'));
  const command = target.startsWith('win-')
    ? '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\cli.js" %*\r\n'
    : '#!/bin/sh\nexec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/runtime/node" "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/app/cli.js" "$@"\n';
  const commandName = target.startsWith('win-') ? 'quorum-storage-agent.cmd' : 'quorum-storage-agent';
  await writeFile(join(rootDirectory, commandName), command, {mode: target.startsWith('win-') ? 0o644 : 0o755});
  if (!target.startsWith('win-')) await chmod(join(rootDirectory, commandName), 0o755);
  const metadata = {schemaVersion: 1, product: 'Quorum Chair Storage Agent', agentVersion, nodeVersion, target,
    runtimeSha256: sha256(runtime), signed: false, notarized: false};
  await writeFile(join(rootDirectory, 'RELEASE.json'), `${JSON.stringify(metadata, null, 2)}\n`, {mode: 0o644});
  return metadata;
}

export async function archiveReleaseStage({stageDirectory, outputPath}) {
  const rootName = basename(stageDirectory); const entries = (await collectStageEntries(stageDirectory))
    .map(entry => ({...entry, path: `${rootName}/${entry.path}`}));
  const archive = outputPath.endsWith('.zip') ? createDeterministicZip(entries) : createDeterministicTarGz(entries);
  await mkdir(dirname(outputPath), {recursive: true}); await writeFile(outputPath, archive, {mode: 0o644});
  return {sha256: sha256(archive), size: archive.length};
}

export function readReleaseArchive(path, value) {
  return path.endsWith('.zip') ? readZip(value) : readTarGz(value);
}

export function verifyReleaseEntries({entries, target, agentVersion, nodeVersion, forbiddenValues = []}) {
  const prefix = `quorum-storage-agent-${agentVersion}-${target}/`; const paths = entries.map(entry => entry.path);
  if (paths.some(path => !path.startsWith(prefix))) throw new Error('Release archive has an unexpected root.');
  const relative = paths.map(path => path.slice(prefix.length));
  if (new Set(relative).size !== relative.length) throw new Error('Release archive contains duplicate paths.');
  const runtimeName = target.startsWith('win-') ? 'runtime/node.exe' : 'runtime/node';
  const commandName = target.startsWith('win-') ? 'quorum-storage-agent.cmd' : 'quorum-storage-agent';
  for (const required of [runtimeName, commandName, 'app/cli.js', 'app/package.json', 'INSTALL.md', 'RELEASE.json', 'THIRD_PARTY_NOTICES/Node.js-LICENSE.txt']) {
    if (!relative.includes(required)) throw new Error(`Release archive is missing ${required}.`);
  }
  const exact = new Set([runtimeName, commandName, 'app/package.json', 'INSTALL.md', 'RELEASE.json', 'THIRD_PARTY_NOTICES/Node.js-LICENSE.txt']);
  if (relative.some(path => !exact.has(path) && !/^app\/[a-z0-9-]+\.js$/.test(path))) {
    throw new Error('Release archive contains a file outside the release allowlist.');
  }
  const metadata = JSON.parse(entries[relative.indexOf('RELEASE.json')].data.toString());
  if (metadata.agentVersion !== agentVersion || metadata.nodeVersion !== nodeVersion || metadata.target !== target) throw new Error('Release metadata does not match the target lock.');
  if (metadata.schemaVersion !== 1 || metadata.product !== 'Quorum Chair Storage Agent' || typeof metadata.signed !== 'boolean' || typeof metadata.notarized !== 'boolean') {
    throw new Error('Release metadata schema is invalid.');
  }
  const runtime = entries[relative.indexOf(runtimeName)];
  if (sha256(runtime.data) !== metadata.runtimeSha256) throw new Error('Bundled runtime does not match release metadata.');
  const command = entries[relative.indexOf(commandName)];
  if (!target.startsWith('win-') && ((runtime.mode & 0o111) === 0 || (command.mode & 0o111) === 0)) {
    throw new Error('POSIX runtime or command is not executable.');
  }
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length); const shouldExecute = !target.startsWith('win-') && (path === runtimeName || path === commandName);
    if (Boolean(entry.mode & 0o111) !== shouldExecute) throw new Error(`Release entry mode is invalid: ${path}`);
  }
  const appFiles = new Set(relative.filter(path => path.startsWith('app/')));
  for (const entry of entries.filter(value => /^app\/[a-z0-9-]+\.js$/.test(value.path.slice(prefix.length)))) {
    const source = entry.data.toString(); const imports = source.matchAll(/(?:\bfrom\s+|\bimport\s*\()['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('./') || !appFiles.has(`app/${specifier.slice(2)}`)) throw new Error(`Release app has an unavailable dependency: ${specifier}`);
    }
  }
  const searchable = entries.filter(entry => !entry.path.endsWith(runtimeName)).map(entry => entry.data.toString()).join('\n');
  for (const forbidden of forbiddenValues.filter(value => typeof value === 'string' && value.length >= 6)) {
    if (searchable.includes(forbidden)) throw new Error('Release archive contains a forbidden local or secret value.');
  }
  return metadata;
}

export async function updateReleaseMetadata(stageDirectory, changes) {
  const path = join(stageDirectory, 'RELEASE.json'); const metadata = JSON.parse(await readFile(path, 'utf8'));
  const updated = {...metadata, ...changes}; await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, {mode: 0o644}); return updated;
}
