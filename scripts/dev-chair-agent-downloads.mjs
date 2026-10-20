import {randomUUID} from 'node:crypto';
import {createReadStream, existsSync, readFileSync} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {checksum} from './chair-agent-downloads.mjs';

const repository = resolve(import.meta.dirname, '..');
const defaultOutput = join(repository, 'release/dev-chair-agent');
const prefix = '/downloads/chair-agent/dev/';
const targets = {linux: ['linux-x64', '.AppImage'], windows: ['win-x64', '-Setup.exe']};

function validateArtifact(item) {
  if (!item || !/^[\w-][\w.-]*$/.test(item.file) || !Number.isSafeInteger(item.size) || item.size <= 0
    || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid development artifact');
}

export function readDevelopmentRelease(directory = defaultOutput) {
  const path = join(directory, 'manifest.json');
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.development !== true || !manifest.platforms
    || !Object.keys(manifest.platforms).length) throw new Error('Invalid development manifest');
  for (const [platform, item] of Object.entries(manifest.platforms)) {
    validateArtifact(item);
    if (!targets[platform] || !item.file.endsWith(targets[platform][1])
      || item.url !== `${prefix}${item.sha256}/${item.file}`) throw new Error('Invalid development download URL');
  }
  return manifest;
}

// Explicitly prepare one platform; never writes to the production public directory.
export async function prepareDevelopmentDownload({platform, from, output = defaultOutput}) {
  if (!targets[platform]) throw new Error('Expected platform linux or windows');
  const build = JSON.parse((await readFile(join(from, 'release-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
  if (build.schemaVersion !== 1 || build.target !== targets[platform][0]
    || !/^[a-f0-9]{40}$/.test(build.commit) || typeof build.sourceDirty !== 'boolean'
    || !/^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(build.version) || !Array.isArray(build.artifacts)) {
    throw new Error('Invalid platform build manifest');
  }
  for (const item of build.artifacts) validateArtifact(item);
  const matches = build.artifacts.filter(item => item.file.endsWith(targets[platform][1]));
  if (matches.length !== 1) throw new Error('Expected one installer');
  if (!build.artifacts.some(item => /-source\.(zip|tar\.gz)$/.test(item.file))) throw new Error('Missing corresponding source');
  for (const item of build.artifacts) {
    const path = join(from, item.file);
    if (!(await lstat(path)).isFile() || (await lstat(path)).size !== item.size
      || await checksum(path) !== item.sha256) throw new Error(`Artifact checksum mismatch: ${item.file}`);
  }
  const item = matches[0];
  await mkdir(output, {recursive: true});
  // Prevent simultaneous manual preparations from losing another platform's update.
  const lock = join(output, '.prepare-lock');
  await mkdir(lock);
  const temporary = join(output, `.manifest-${randomUUID()}.json`);
  const staged = join(output, `.installer-${randomUUID()}`);
  try {
    const previous = readDevelopmentRelease(output);
    const destination = join(output, item.sha256);
    await mkdir(destination, {recursive: true});
    if (await realpath(destination) !== join(await realpath(output), item.sha256)) throw new Error('Unsafe output directory');
    await copyFile(join(from, item.file), staged);
    if (await checksum(staged) !== item.sha256) throw new Error('Installer changed during preparation');
    await rename(staged, join(destination, item.file));
    const manifest = {schemaVersion: 1, development: true, platforms: {...previous?.platforms,
      [platform]: {...item, url: `${prefix}${item.sha256}/${item.file}`, commit: build.commit,
        sourceDirty: build.sourceDirty, agentVersion: build.version}}};
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
    await rename(temporary, join(output, 'manifest.json'));
    return manifest;
  } finally {
    await rm(staged, {force: true});
    await rm(temporary, {force: true});
    await rm(lock, {recursive: true, force: true});
  }
}

export function developmentDownloadPlugin(manifest, directory = defaultOutput) {
  return {name: 'quorum-development-agent-downloads', apply: 'serve', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = (request.url ?? '').split('?')[0];
      if (path !== prefix.slice(0, -1) && !path.startsWith(prefix)) return next();
      const item = Object.values(manifest?.platforms ?? {}).find(item => item.url === path);
      if (!item) { response.statusCode = 404; response.end(); return; }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.statusCode = 405; response.setHeader('Allow', 'GET, HEAD'); response.end(); return;
      }
      void (async () => {
        const file = join(directory, item.sha256, item.file);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size !== item.size || await realpath(file) !== join(await realpath(directory), item.sha256, item.file)) {
          throw new Error('Unavailable installer');
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Disposition', `attachment; filename="${item.file}"`);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Length', item.size);
        if (request.method === 'HEAD') response.end();
        else await pipeline(createReadStream(file), response);
      })().catch(() => {
        if (response.headersSent) response.destroy();
        else { response.statusCode = 404; response.end(); }
      });
    });
  }};
}

export function checkDevelopmentSources(cwd = repository) {
  const files = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages', 'scripts'], {cwd, encoding: 'utf8'}).trim();
  if (files) throw new Error(`Track new source files with git add before packaging:\n${files}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'check-source') checkDevelopmentSources();
  else {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--platform' || args[2] !== '--from') {
      throw new Error('Usage: pnpm dev:chair-agent:prepare --platform linux|windows --from <build-directory>');
    }
    const manifest = await prepareDevelopmentDownload({platform: args[1], from: resolve(args[3])});
    for (const [platform, item] of Object.entries(manifest.platforms)) {
      console.log(`${platform}: ${item.url}\n  Agent ${item.agentVersion}, commit ${item.commit}, modified source: ${item.sourceDirty}`);
    }
    console.log('Restart pnpm start and refresh the page to use these downloads.');
  }
}
