#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {copyFile, lstat, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {
  archiveReleaseStage, collectStageEntries, createDeterministicZip, downloadPinnedArchive,
  materializeReleaseStage, readZip, runtimeFilesFromArchive, sha256, sha256File, updateReleaseMetadata
} from './storage-agent-release-lib.mjs';
import {verifyWindowsDesktopEntries} from './storage-agent-windows-release-lib.mjs';

const repository = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const has = name => args.includes(name);
const output = resolve(option('--output') ?? join(repository, 'release/windows'));
const runtimeLock = JSON.parse(await readFile(join(repository, 'scripts/storage-agent-runtime-lock.json'), 'utf8'));
const toolLock = JSON.parse(await readFile(join(repository, 'scripts/windows/toolchain-lock.json'), 'utf8'));
const agentPackage = JSON.parse(await readFile(join(repository, 'packages/storage-agent/package.json'), 'utf8'));
const version = agentPackage.version;
const artifactBase = `Quorum-Chair-Agent-${version}-win-x64`;
const stage = join(output, artifactBase);
const rustOutput = resolve(option('--rust-output') ?? join(repository, 'packages/storage-agent-desktop/target/release'));
const dist = resolve(option('--dist') ?? join(repository, 'packages/storage-agent/dist'));
const sourceName = `${artifactBase}-source.zip`;
await mkdir(output, {recursive: true});

function git(args_) {return execFileSync('git', args_, {cwd: repository, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024}).trim();}
const commit = git(['rev-parse', 'HEAD']);
const sourceDirty = git(['status', '--porcelain']).length > 0;
const cargo = JSON.parse((await readFile(resolve(option('--cargo-metadata') ?? join(repository, '.tools/windows/cargo-metadata-release.json')), 'utf8')).replace(/^\uFEFF/, ''));

// The source archive contains tracked application/build source and exact Cargo
// dependency source. It never scans the checkout for local configurations.
async function buildSourceArchive() {
  const entries = [];
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const additions = [
    'scripts/build-storage-agent-windows.mjs', 'scripts/package-storage-agent-windows.ps1',
    'scripts/windows/chair-agent.iss', 'scripts/windows/INSTALL.md', 'scripts/windows/toolchain-lock.json',
    'scripts/windows/ChineseSimplified.isl', 'scripts/windows/smoke.ps1',
    'scripts/storage-agent-windows-release.test.ts', '.github/workflows/build-chair-agent-windows.yml',
    'scripts/storage-agent-windows-release-lib.mjs',
    'packages/storage-agent-desktop/assets/quorum-agent.ico', 'packages/storage-agent-desktop/assets/quorum-agent.rc'
  ];
  for (const path of [...new Set([...tracked, ...additions])].sort()) {
    if (/^(?:\.git|\.tools|release|node_modules)(?:\/|$)/.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path)) continue;
    const absolute = join(repository, path);
    const info = await lstat(absolute).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe source entry: ${path}`);
    const executable = /\.sh$/.test(path) || path === 'scripts/appimage/AppRun';
    entries.push({path: `source/${path}`, data: await readFile(absolute), mode: executable ? 0o100755 : 0o100644});
  }
  for (const item of cargo.packages.filter(item => item.source)) {
    const root = dirname(item.manifest_path);
    for (const entry of await collectStageEntries(root)) {
      entries.push({...entry, path: `source/vendor/${item.name}-${item.version}/${entry.path}`, mode: 0o100644});
    }
  }
  entries.push({path: 'source/.cargo/config.toml', mode: 0o100644, data: Buffer.from(
    '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n')});
  entries.push({path: 'source/WINDOWS-SOURCE.md', mode: 0o100644, data: Buffer.from(
    `# Windows corresponding source\n\nApplication commit: ${commit}\nWorking-tree modifications included: ${sourceDirty}\n` +
    `Rust ${toolLock.rustVersion}; Node ${runtimeLock.nodeVersion}; pnpm ${JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).packageManager}.\n\n` +
    'Install the Windows MSVC Build Tools/SDK and official tools described in docs/self-hosted/CHAIR_AGENT_WINDOWS_SETUP.md.\n' +
    'Run pnpm install --frozen-lockfile, then pnpm release:storage-agent:windows. Vendored Rust sources and lockfiles are included.\n' +
    'The build uses a static CRT. Inno Setup is needed only for the installer, not to run the binary.\n')});
  const archive = createDeterministicZip(entries);
  await writeFile(join(output, sourceName), archive);
  return {file: sourceName, sha256: sha256(archive), size: archive.length, commit, sourceDirty};
}

const source = await buildSourceArchive();
const pinned = runtimeLock.targets['win-x64'];
const cache = resolve(option('--runtime-cache') ?? join(repository, '.tools/downloads'));
const runtimePath = await downloadPinnedArchive({url: `${runtimeLock.baseUrl}/${pinned.archive}`, destination: join(cache, pinned.archive),
  expectedSha256: pinned.sha256, offline: has('--offline')});
const runtime = runtimeFilesFromArchive('win-x64', pinned.archive, await readFile(runtimePath));
await materializeReleaseStage({rootDirectory: stage, distDirectory: dist, target: 'win-x64', agentVersion: version,
  nodeVersion: runtimeLock.nodeVersion, pairingModulePath: join(repository, 'packages/contracts/dist/agent-pairing.js'),
  releaseReadmePath: join(repository, 'scripts/windows/INSTALL.md'), platformHelper: await readFile(join(rustOutput, 'quorum-agent-platform.exe')), ...runtime});
for (const name of ['quorum-storage-agent-desktop.exe', 'quorum-agent-platform.exe']) await copyFile(join(rustOutput, name), join(stage, name));
await copyFile(join(repository, 'packages/storage-agent-desktop/assets/quorum-agent.ico'), join(stage, 'quorum-agent.ico'));
await copyFile(join(repository, 'LICENSE'), join(stage, 'LICENSE.Quorum'));
await writeFile(join(stage, 'quorum-storage-agent.cmd'), '@echo off\r\nsetlocal\r\nset "QUORUM_AGENT_PLATFORM=%~dp0quorum-agent-platform.exe"\r\n"%~dp0runtime\\node.exe" "%~dp0app\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
await writeFile(join(stage, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
const notices = join(stage, 'THIRD_PARTY_NOTICES/rust');
await mkdir(notices, {recursive: true});
for (const item of cargo.packages.filter(item => item.source)) {
  const destination = join(notices, `${item.name}-${item.version}`);
  await mkdir(destination, {recursive: true});
  await writeFile(join(destination, 'metadata.json'), `${JSON.stringify({name: item.name, version: item.version, license: item.license, repository: item.repository}, null, 2)}\n`);
  const folder = dirname(item.manifest_path);
  for (const name of await readdir(folder)) {
    if (/^(?:license|licence|copying|notice)/i.test(name) && (await lstat(join(folder, name))).isFile()) await copyFile(join(folder, name), join(destination, name));
  }
}
const innoDirectory = resolve(option('--inno-dir') ?? join(repository, '.tools/windows/innosetup'));
await copyFile(join(innoDirectory, 'license.txt'), join(stage, 'THIRD_PARTY_NOTICES/Inno-Setup-LICENSE.txt'));
await updateReleaseMetadata(stage, {desktop: true, minimumWindowsVersion: '10.0.19045', architecture: 'x64',
  rustVersion: toolLock.rustVersion, crt: 'static', source, innoSetupVersion: toolLock.innoSetup.version,
  nativeSha256: {gui: await sha256File(join(stage, 'quorum-storage-agent-desktop.exe')), platform: await sha256File(join(stage, 'quorum-agent-platform.exe'))}});

const zipPath = join(output, `${artifactBase}.zip`);
await archiveReleaseStage({stageDirectory: stage, outputPath: zipPath});
const zipEntries = readZip(await readFile(zipPath));
const verified = verifyWindowsDesktopEntries(zipEntries, {rootName: artifactBase, agentVersion: version, nodeVersion: runtimeLock.nodeVersion,
  forbiddenValues: [repository, process.env.QUORUM_AGENT_RELEASE_FORBIDDEN_VALUE]});
await writeFile(join(output, 'PE-DEPENDENCIES.json'), `${JSON.stringify(verified.binaries, null, 2)}\n`);

execFileSync(join(innoDirectory, 'ISCC.exe'), ['/Qp', `/DStageDir=${stage}`, `/DArtifactDir=${output}`, `/DAgentVersion=${version}`,
  join(repository, 'scripts/windows/chair-agent.iss')], {stdio: 'inherit'});
const artifactNames = [`${artifactBase}.zip`, `${artifactBase}-Setup.exe`, sourceName];
const artifacts = [];
for (const file of artifactNames) {
  const path = join(output, file); artifacts.push({file, sha256: await sha256File(path), size: (await lstat(path)).size});
}
await writeFile(join(output, 'SHA256SUMS'), `${artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`);
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify({schemaVersion: 1, product: 'Quorum Chair Agent', version, target: 'win-x64',
  minimumWindowsVersion: '10.0.19045', signed: false, commit, sourceDirty, artifacts}, null, 2)}\n`);
for (const item of artifacts) console.log(`${item.sha256}  ${item.file}`);
