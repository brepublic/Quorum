// @vitest-environment node
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink, copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer, build, loadConfigFromFile} from 'vite';
import {checksum} from './chair-agent-downloads.mjs';
import {prepareDevelopmentDownload, readDevelopmentRelease, developmentDownloadPlugin, checkDevelopmentSources} from './dev-chair-agent-downloads.mjs';

let directory: string;
let output: string;
beforeEach(async () => {directory = await mkdtemp(join(tmpdir(), 'quorum-dev-download-')); output = join(directory, 'downloads');});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, {recursive: true, force: true});
});
async function fixture(platform = 'linux', content = 'first installer') {
  const from = join(directory, platform); await mkdir(from, {recursive: true});
  const file = platform === 'linux' ? 'Agent.AppImage' : 'Agent-Setup.exe';
  const artifacts = [];
  for (const name of [file, 'Agent-source.zip']) {
    await writeFile(join(from, name), content);
    artifacts.push({file: name, size: Buffer.byteLength(content), sha256: await checksum(join(from, name))});
  }
  await writeFile(join(from, 'release-manifest.json'), JSON.stringify({schemaVersion: 1, target: platform === 'linux' ? 'linux-x64' : 'win-x64',
    commit: 'a'.repeat(40), version: '0.1.0', sourceDirty: true, artifacts}));
  return from;
}
it('allows modified sources and independent platforms, changes URLs and retains old package bytes', async () => {
  const first = await prepareDevelopmentDownload({platform: 'linux', from: await fixture(), output});
  expect(Object.keys(first.platforms)).toEqual(['linux']);
  expect(first.platforms.linux.sourceDirty).toBe(true);
  const both = await prepareDevelopmentDownload({platform: 'windows', from: await fixture('windows'), output});
  const updated = await prepareDevelopmentDownload({platform: 'linux', from: await fixture('linux', 'second installer'), output});
  expect(updated.platforms.windows).toEqual(both.platforms.windows);
  expect(updated.platforms.linux.url).not.toBe(first.platforms.linux.url);
  expect(await readFile(join(output, first.platforms.linux.sha256, first.platforms.linux.file), 'utf8')).toBe('first installer');
  expect(readDevelopmentRelease(output)).toEqual(updated);
});
it('preserves the published manifest when source or installer validation fails', async () => {
  const from = await fixture();
  const first = await prepareDevelopmentDownload({platform: 'linux', from, output});
  for (const file of ['Agent.AppImage', 'Agent-source.zip']) {
    await fixture(); await writeFile(join(from, file), 'corrupt');
    await expect(prepareDevelopmentDownload({platform: 'linux', from, output})).rejects.toThrow('checksum');
    expect(readDevelopmentRelease(output)).toEqual(first);
  }
});
it('rejects wrong platforms, traversal, symlinks and missing build manifests', async () => {
  const from = await fixture();
  await expect(prepareDevelopmentDownload({platform: 'windows', from, output})).rejects.toThrow('platform');
  const manifest = JSON.parse(await readFile(join(from, 'release-manifest.json'), 'utf8'));
  manifest.artifacts[0].file = '../Agent.AppImage';
  await writeFile(join(from, 'release-manifest.json'), JSON.stringify(manifest));
  await expect(prepareDevelopmentDownload({platform: 'linux', from, output})).rejects.toThrow('artifact');
  await fixture(); await rm(join(from, 'Agent.AppImage')); await symlink(join(from, 'Agent-source.zip'), join(from, 'Agent.AppImage'));
  await expect(prepareDevelopmentDownload({platform: 'linux', from, output})).rejects.toThrow('checksum');
  await rm(join(from, 'release-manifest.json'));
  await expect(prepareDevelopmentDownload({platform: 'linux', from, output})).rejects.toThrow();
});
it('serves exact attachment bytes over Vite and returns 404 outside the manifest', async () => {
  const manifest = await prepareDevelopmentDownload({platform: 'linux', from: await fixture(), output});
  const server = await createServer({configFile: false, root: directory, plugins: [developmentDownloadPlugin(manifest, output)],
    server: {host: '127.0.0.1', port: 0}, logLevel: 'silent'});
  try {
    await server.listen();
    const address = server.httpServer!.address() as {port: number};
    const origin = `http://127.0.0.1:${address.port}`;
    const item = manifest.platforms.linux;
    const response = await fetch(origin + item.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(join(directory, 'downloaded'), bytes);
    expect(await checksum(join(directory, 'downloaded'))).toBe(item.sha256);
    expect((await fetch(origin + item.url, {method: 'HEAD'})).headers.get('content-length')).toBe(String(item.size));
    expect((await fetch(origin + item.url, {method: 'POST'})).status).toBe(405);
    for (const path of ['/downloads/chair-agent/dev/manifest.json', '/downloads/chair-agent/dev/unknown.exe', '/downloads/chair-agent/dev/%2e%2e/secret']) {
      expect((await fetch(origin + path)).status).toBe(404);
    }
    await rm(join(output, item.sha256, item.file));
    expect((await fetch(origin + item.url)).status).toBe(404);
  } finally {await server.close();}
});
it('keeps development files out of actual Vite production builds and preview, retaining release identity checks', async () => {
  vi.stubEnv('RELEASE_TAG', '');
  vi.stubEnv('GITHUB_SHA', '');
  // Run the real repository config in an isolated miniature checkout.
  await mkdir(join(directory, 'scripts'));
  for (const file of ['vite.config.ts', 'scripts/dev-chair-agent-downloads.mjs', 'scripts/chair-agent-downloads.mjs']) {
    await copyFile(resolve(file), join(directory, file));
  }
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(directory, 'main.js'), 'document.body.textContent = JSON.stringify(__CHAIR_AGENT_RELEASE__);');
  const devOutput = join(directory, 'release/dev-chair-agent');
  const from = await fixture();
  const cli = execFileSync(process.execPath, [join(directory, 'scripts/dev-chair-agent-downloads.mjs'), '--platform', 'linux', '--from', from], {encoding: 'utf8'});
  expect(cli).toContain('Restart pnpm start');
  const manifest = readDevelopmentRelease(devOutput);
  const configFile = join(directory, 'vite.config.ts');
  const serve = await loadConfigFromFile({command: 'serve', mode: 'development'}, configFile);
  expect(serve!.config.define!.__CHAIR_AGENT_RELEASE__).toContain(manifest.platforms.linux.url);
  const preview = await loadConfigFromFile({command: 'serve', mode: 'production', isPreview: true}, configFile);
  expect(preview!.config.define!.__CHAIR_AGENT_RELEASE__).toBe('null');
  const result: any = await build({root: directory, configFile, logLevel: 'silent', build: {write: false}});
  const rendered = result.output.map((item: any) => item.code ?? item.source).join('');
  expect(rendered).not.toContain(manifest.platforms.linux.url);
  expect(rendered).not.toContain('first installer');
  expect(rendered).toContain('JSON.stringify(null)');
  // A malformed development manifest must not affect production at all.
  await writeFile(join(devOutput, 'manifest.json'), 'invalid development JSON');
  const formalDirectory = join(directory, 'public/downloads/chair-agent');
  await mkdir(formalDirectory, {recursive: true});
  const formal = {schemaVersion: 1, serverVersion: 'v1.2.3', commit: 'b'.repeat(40), platforms: {}};
  await writeFile(join(formalDirectory, 'manifest.json'), JSON.stringify(formal));
  const production = await loadConfigFromFile({command: 'build', mode: 'production'}, configFile);
  expect(JSON.parse(production!.config.define!.__CHAIR_AGENT_RELEASE__)).toEqual(formal);
  vi.stubEnv('RELEASE_TAG', formal.serverVersion);
  vi.stubEnv('GITHUB_SHA', formal.commit);
  const release = await loadConfigFromFile({command: 'build', mode: 'production'}, configFile);
  expect(JSON.parse(release!.config.define!.__CHAIR_AGENT_RELEASE__)).toEqual(formal);
  vi.stubEnv('RELEASE_TAG', 'v9.9.9');
  await expect(loadConfigFromFile({command: 'build', mode: 'production'}, configFile)).rejects.toThrow('does not match');
  vi.stubEnv('RELEASE_TAG', formal.serverVersion);
  vi.stubEnv('GITHUB_SHA', 'c'.repeat(40));
  await expect(loadConfigFromFile({command: 'build', mode: 'production'}, configFile)).rejects.toThrow('does not match');
  vi.stubEnv('GITHUB_SHA', formal.commit);
  await rm(join(formalDirectory, 'manifest.json'));
  await expect(loadConfigFromFile({command: 'build', mode: 'production'}, configFile)).rejects.toThrow('does not match');
});
it('detects untracked packaging inputs without requiring a clean worktree', async () => {
  execFileSync('git', ['init', '-q', directory]);
  await mkdir(join(directory, 'packages'));
  await writeFile(join(directory, 'packages/new.ts'), 'new source');
  expect(() => checkDevelopmentSources(directory)).toThrow('git add');
  execFileSync('git', ['add', 'packages/new.ts'], {cwd: directory});
  await writeFile(join(directory, 'packages/new.ts'), 'modified source');
  expect(() => checkDevelopmentSources(directory)).not.toThrow();
});
