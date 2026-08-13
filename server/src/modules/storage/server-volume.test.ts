// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {DurableStagingStore} from './staging';
import {ProviderStorageError, ServerVolumeStore, type ServerVolumeOperations} from './server-volume';

const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `quorum-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

async function fixture(content = 'server-volume-content') {
  const staging = new DurableStagingStore(await temporaryRoot('staging'), 1024, 2048);
  const volume = new ServerVolumeStore(await temporaryRoot('volume'), 1024);
  await staging.initialize();
  await volume.initialize();
  const stagingKey = `uploads/aa/${randomUUID().replaceAll('-', '')}`;
  await staging.write({key: stagingKey, source: (async function* () { yield content; })(),
    expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
  return {staging, volume, stagingKey, content};
}

const operations = (overrides: Partial<ServerVolumeOperations> = {}): ServerVolumeOperations => ({
  link, lstat, mkdir, open, realpath, unlink,
  syncFile: handle => handle.sync(),
  syncDirectory: handle => handle.sync(),
  ...overrides
});

describe('SERVER_VOLUME provider', () => {
  it('streams staged bytes to a blob-derived path and re-verifies the final file', async () => {
    const {staging, volume, stagingKey, content} = await fixture();
    const blobId = randomUUID();
    const result = await volume.commitFromStaging({blobId, staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    expect(result).toEqual({storageKey: volume.keyForBlob(blobId),
      sizeBytes: Buffer.byteLength(content), sha256: digest(content)});
    expect(result.storageKey).toMatch(/^blobs\/[a-f0-9]{2}\/[a-f0-9]{32}$/);
    expect(await readFile(volume.pathForKey(result.storageKey), 'utf8')).toBe(content);
    expect((await lstat(volume.pathForKey(result.storageKey))).mode & 0o777).toBe(0o600);
    const chunks: Buffer[] = [];
    for await (const chunk of volume.read(result.storageKey, result.sizeBytes, result.sha256)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);

    const replay = await volume.commitFromStaging({blobId, staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    expect(replay).toEqual(result);
  });

  it.each([
    ['file open', {open: async () => { throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); }}],
    ['file sync', {syncFile: async () => { throw new Error('fsync failed'); }}],
    ['atomic publish', {link: async () => { throw Object.assign(new Error('link failed'), {code: 'EIO'}); }}]
  ])('keeps staging when %s fails', async (_name, override) => {
    const {staging, stagingKey, content} = await fixture();
    const volume = new ServerVolumeStore(await temporaryRoot('failure'), 1024,
      operations(override as Partial<ServerVolumeOperations>));
    await volume.initialize();
    await expect(volume.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)}))
      .rejects.toBeInstanceOf(ProviderStorageError);
    expect(await staging.exists(stagingKey)).toBe(true);
  });

  it('rejects corrupted final bytes during provider verification', async () => {
    const {staging, volume, stagingKey, content} = await fixture();
    const blobId = randomUUID();
    const result = await volume.commitFromStaging({blobId, staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    await writeFile(volume.pathForKey(result.storageKey), 'corrupt');
    await expect(volume.verify(result.storageKey, result.sizeBytes, result.sha256)).rejects.toMatchObject({
      failureCode: 'PROVIDER_INTEGRITY_MISMATCH'
    });
    expect(await staging.exists(stagingKey)).toBe(true);
  });

  it('deletes only the committed provider copy and treats a missing copy as success', async () => {
    const {staging, volume, stagingKey, content} = await fixture();
    const result = await volume.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    await volume.delete(result.storageKey);
    await expect(readFile(volume.pathForKey(result.storageKey))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await staging.exists(stagingKey)).toBe(true);
    await expect(volume.delete(result.storageKey)).resolves.toBeUndefined();
  });

  it('refuses to delete symbolic links and multiply-linked files', async () => {
    const {staging, volume, stagingKey, content} = await fixture();
    const symlinkResult = await volume.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    const outside = join(await temporaryRoot('delete-outside'), 'outside');
    await writeFile(outside, content);
    await unlink(volume.pathForKey(symlinkResult.storageKey));
    await symlink(outside, volume.pathForKey(symlinkResult.storageKey));
    await expect(volume.delete(symlinkResult.storageKey)).rejects.toMatchObject({
      failureCode: 'SERVER_VOLUME_DELETE_FAILED'
    });
    expect(await readFile(outside, 'utf8')).toBe(content);

    const hardlinkResult = await volume.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    const peer = join(await temporaryRoot('delete-hardlink'), 'peer');
    await link(volume.pathForKey(hardlinkResult.storageKey), peer);
    await expect(volume.delete(hardlinkResult.storageKey)).rejects.toMatchObject({
      failureCode: 'SERVER_VOLUME_DELETE_FAILED'
    });
    expect(await readFile(peer, 'utf8')).toBe(content);
  });

  it('rejects symbolic-link paths, hard-linked files, and non-regular targets', async () => {
    const {staging, stagingKey, content} = await fixture();
    const volumeRoot = await temporaryRoot('unsafe-volume');
    const outside = await temporaryRoot('outside-volume');
    const volume = new ServerVolumeStore(volumeRoot, 1024);
    await volume.initialize();
    await symlink(outside, join(volumeRoot, 'blobs'));
    await expect(volume.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)})).rejects.toMatchObject({
      failureCode: 'SERVER_VOLUME_PATH_INVALID'
    });

    const safeVolume = new ServerVolumeStore(await temporaryRoot('hardlink-volume'), 1024);
    await safeVolume.initialize();
    const blobId = randomUUID();
    const result = await safeVolume.commitFromStaging({blobId, staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    await link(safeVolume.pathForKey(result.storageKey), join(await temporaryRoot('hardlink-peer'), 'peer'));
    await expect(safeVolume.verify(result.storageKey, result.sizeBytes, result.sha256)).rejects.toMatchObject({
      failureCode: 'SERVER_VOLUME_READ_FAILED'
    });

    const directoryVolume = new ServerVolumeStore(await temporaryRoot('directory-volume'), 1024);
    await directoryVolume.initialize();
    const directoryBlobId = randomUUID();
    const directoryTarget = directoryVolume.pathForKey(directoryVolume.keyForBlob(directoryBlobId));
    await mkdir(directoryTarget, {recursive: true});
    await expect(directoryVolume.commitFromStaging({blobId: directoryBlobId, staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)})).rejects.toMatchObject({
      failureCode: 'SERVER_VOLUME_PATH_INVALID'
    });
  });
});
