// @vitest-environment node
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checksum, prepareDownloads} from './chair-agent-downloads.mjs';

let directory: string;
const commit = 'a'.repeat(40);
beforeEach(async () => {directory = await mkdtemp(join(tmpdir(), 'chair-downloads-'));});
afterEach(async () => {await rm(directory, {recursive: true, force: true});});
async function fixture() {
  const options = {windows: join(directory, 'windows'), linux: join(directory, 'linux'), output: join(directory, 'output'),
    tag: 'v1.3.0', commit, repositoryName: 'brepublic/Quorum'};
  for (const [key, target, files] of [
    ['windows', 'win-x64', ['Agent-Setup.exe', 'Agent.zip', 'Agent-source.zip']],
    ['linux', 'linux-x64', ['Agent.AppImage', 'Agent.tar.gz', 'Agent-source.tar.gz']]
  ] as const) {
    const folder = options[key]; await mkdir(folder);
    const artifacts = [];
    for (const file of files) {
      await writeFile(join(folder, file), file);
      artifacts.push({file, size: Buffer.byteLength(file), sha256: await checksum(join(folder, file))});
    }
    await writeFile(join(folder, 'release-manifest.json'), JSON.stringify({schemaVersion: 1, version: '0.1.0', commit, sourceDirty: false, target, artifacts}));
  }
  return options;
}
it.each(['v1.3.0', 'v1.3.0-rc.1'])('ships only two installers and pins both URLs and release identity for %s', async tag => {
  const options = {...await fixture(), tag}; const manifest = await prepareDownloads(options);
  expect(await readdir(join(options.output, options.tag))).toEqual(['Agent-Setup.exe', 'Agent.AppImage']);
  expect(manifest.releaseUrl).toBe(`https://github.com/brepublic/Quorum/releases/tag/${tag}`);
  expect(manifest.platforms.windows.url).toBe(`/downloads/chair-agent/${tag}/Agent-Setup.exe`);
  expect(await checksum(join(options.output, options.tag, 'Agent.AppImage'))).toBe(manifest.platforms.linux.sha256);
  expect(await readFile(join(options.output, 'SHA256SUMS'), 'utf8')).toContain(`${manifest.platforms.windows.sha256}  ${tag}/Agent-Setup.exe`);
});
it.each(['commit', 'sourceDirty', 'version'])('rejects mismatched %s before copying installers', async field => {
  const options = await fixture(); const path = join(options.linux, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest[field] = field === 'sourceDirty' ? true : field === 'version' ? '0.2.0' : 'b'.repeat(40);
  await writeFile(path, JSON.stringify(manifest));
  await expect(prepareDownloads(options)).rejects.toThrow('does not match');
  expect(await readdir(options.output)).toEqual([]);
});
it('rejects corrupt installers and corresponding source', async () => {
  const options = await fixture(); await writeFile(join(options.windows, 'Agent-source.zip'), 'corrupted');
  await expect(prepareDownloads(options)).rejects.toThrow('checksum');
  expect(await readdir(options.output)).toEqual([]);
});
it('rejects missing platform artifacts and refuses to accumulate old versions', async () => {
  const options = await fixture(); await rm(join(options.linux, 'Agent.AppImage'));
  await expect(prepareDownloads(options)).rejects.toThrow();
  await writeFile(join(options.output, 'old.exe'), 'old');
  await expect(prepareDownloads(options)).rejects.toThrow('must be empty');
});
it('rejects path traversal and missing source assets', async () => {
  const options = await fixture(); const path = join(options.windows, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.artifacts[0].file = '../Agent-Setup.exe';
  await writeFile(path, JSON.stringify(manifest));
  await expect(prepareDownloads(options)).rejects.toThrow('artifact name');
  manifest.artifacts = manifest.artifacts.filter((item: {file: string}) => item.file === 'Agent.zip');
  await writeFile(path, JSON.stringify(manifest));
  await expect(prepareDownloads(options)).rejects.toThrow('Expected one');
});
