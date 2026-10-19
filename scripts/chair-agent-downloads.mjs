import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, join, basename} from 'node:path';
import {pathToFileURL} from 'node:url';

const repository = resolve(import.meta.dirname, '..');
export async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Called only after the Linux package and clean-runtime smoke checks pass.
export async function recordLinuxBuild(directory) {
  const {version} = JSON.parse(await readFile(join(repository, 'packages/storage-agent/package.json'), 'utf8'));
  const artifacts = [];
  for (const file of (await readdir(directory)).filter(file => /\.(AppImage|tar\.gz)$/.test(file)).sort()) {
    artifacts.push({file, size: (await lstat(join(directory, file))).size, sha256: await checksum(join(directory, file))});
  }
  const git = args => execFileSync('git', args, {cwd: repository, encoding: 'utf8'}).trim();
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify({schemaVersion: 1, version,
    commit: git(['rev-parse', 'HEAD']), sourceDirty: git(['status', '--porcelain']).length > 0,
    target: 'linux-x64', artifacts}, null, 2) + '\n');
}

export async function prepareDownloads({windows, linux, output, tag, commit, repositoryName}) {
  if (!/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(tag) || !/^[a-f0-9]{40}$/.test(commit)
    || !/^[\w.-]+\/[\w.-]+$/.test(repositoryName)) throw new Error('Invalid release identity');
  // Never silently retain older packages in a reused output directory.
  await mkdir(output, {recursive: true});
  if ((await readdir(output)).length) throw new Error('Download output must be empty');
  const platforms = {};
  let agentVersion;
  for (const [platform, directory, target, suffix] of [
    ['windows', windows, 'win-x64', '-Setup.exe'], ['linux', linux, 'linux-x64', '.AppImage']
  ]) {
    const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.commit !== commit || manifest.sourceDirty !== false
      || manifest.target !== target || !/^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(manifest.version)
      || (agentVersion && agentVersion !== manifest.version)) throw new Error('Agent build does not match release');
    agentVersion = manifest.version;
    const matches = manifest.artifacts.filter(item => item.file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${platform} installer`);
    // Check all release assets, including corresponding source, before publishing.
    for (const artifact of manifest.artifacts) {
      if (artifact.file !== basename(artifact.file) || artifact.file.includes('\\')
        || !/^[\w.-]+$/.test(artifact.file)) throw new Error('Invalid artifact name');
      const path = join(directory, artifact.file);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size === 0 || stat.size !== artifact.size
        || await checksum(path) !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${artifact.file}`);
    }
    if (!manifest.artifacts.some(item => /-source\.(zip|tar\.gz)$/.test(item.file))) throw new Error('Missing corresponding source');
    const artifact = matches[0];
    platforms[platform] = {...artifact, url: `/downloads/chair-agent/${tag}/${artifact.file}`};
  }
  // Verify both platforms before materializing either one.
  await mkdir(join(output, tag));
  for (const [platform, directory] of [['windows', windows], ['linux', linux]]) {
    await copyFile(join(directory, platforms[platform].file), join(output, tag, platforms[platform].file));
  }
  const manifest = {schemaVersion: 1, serverVersion: tag, commit, agentVersion,
    releaseUrl: `https://github.com/${repositoryName}/releases/tag/${tag}`, platforms};
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(output, 'SHA256SUMS'), Object.values(platforms).map(item => `${item.sha256}  ${tag}/${item.file}\n`).join(''));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'record-linux') await recordLinuxBuild(resolve(process.argv[3]));
  else if (process.argv[2] === 'prepare') await prepareDownloads({
    windows: resolve('release/windows'), linux: resolve('release/appimage'), output: resolve('public/downloads/chair-agent'),
    tag: process.env.RELEASE_TAG, commit: process.env.GITHUB_SHA, repositoryName: process.env.GITHUB_REPOSITORY
  });
  else throw new Error('Usage: chair-agent-downloads.mjs record-linux <directory> | prepare');
}
