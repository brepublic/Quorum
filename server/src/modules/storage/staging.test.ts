// @vitest-environment node

import {createHash} from 'node:crypto';
import {link, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {DurableStagingStore, UploadStreamError, type StagingOperations} from './staging';

const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'quorum-staging-'));
  roots.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe('durable upload staging', () => {
  it('streams chunks to a server key and computes size and SHA-256', async () => {
    const directory = await root();
    const store = new DurableStagingStore(directory, 64, 80);
    await store.initialize();
    const content = 'durable-stream';
    const result = await store.write({
      key: 'uploads/aa/001122',
      source: (async function* () { yield 'durable-'; yield Buffer.from('stream'); })(),
      expectedSizeBytes: Buffer.byteLength(content),
      expectedSha256: digest(content),
      contentLength: Buffer.byteLength(content)
    });
    expect(result).toEqual({sizeBytes: Buffer.byteLength(content), sha256: digest(content)});
    expect(await store.verify('uploads/aa/001122', result.sizeBytes, result.sha256)).toEqual(result);
  });

  it.each([
    ['over limit', 4, 4, '12345', 'UPLOAD_TOO_LARGE'],
    ['short write', 16, 5, '1234', 'UPLOAD_SIZE_MISMATCH'],
    ['long write', 16, 4, '12345', 'UPLOAD_SIZE_MISMATCH'],
    ['hash mismatch', 16, 4, '1234', 'UPLOAD_HASH_MISMATCH']
  ])('rejects %s without publishing a staging target', async (_name, limit, expected, content, failureCode) => {
    const directory = await root();
    const store = new DurableStagingStore(directory, limit as number, 32);
    await store.initialize();
    const key = 'uploads/bb/001122';
    const expectedHash = failureCode === 'UPLOAD_HASH_MISMATCH' ? digest('xxxx') : digest(content as string);
    await expect(store.write({key, source: (async function* () { yield content as string; })(),
      expectedSizeBytes: expected as number, expectedSha256: expectedHash})).rejects.toMatchObject({failureCode});
    expect(await store.exists(key)).toBe(false);
  });

  it('treats a broken request stream as incomplete and removes partial bytes', async () => {
    const directory = await root();
    const store = new DurableStagingStore(directory, 64, 80);
    const key = 'uploads/cc/001122';
    const source = (async function* () {
      yield 'partial';
      throw new Error('socket reset');
    })();
    await expect(store.write({key, source, expectedSizeBytes: 10, expectedSha256: digest('0123456789')}))
      .rejects.toMatchObject({failureCode: 'UPLOAD_INTERRUPTED'});
    expect(await store.exists(key)).toBe(false);
  });

  it('maps disk open failures to a stable storage error', async () => {
    const directory = await root();
    const operations: StagingOperations = {
      link,
      lstat,
      mkdir,
      realpath,
      unlink,
      open: async () => { throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); }
    } as StagingOperations;
    const store = new DurableStagingStore(directory, 64, 80, operations);
    await store.initialize();
    await expect(store.write({key: 'uploads/dd/001122', source: (async function* () { yield 'data'; })(),
      expectedSizeBytes: 4, expectedSha256: digest('data')})).rejects.toMatchObject({
      failureCode: 'STAGING_WRITE_FAILED', apiCode: 'SERVICE_NOT_READY'
    });
  });

  it('rejects symbolic-link escapes and non-regular staging targets', async () => {
    const directory = await root();
    const outside = await root();
    const store = new DurableStagingStore(directory, 64, 80);
    await store.initialize();
    await symlink(outside, join(directory, 'uploads'));
    await expect(store.write({key: 'uploads/ee/001122', source: (async function* () { yield 'data'; })(),
      expectedSizeBytes: 4, expectedSha256: digest('data')})).rejects.toBeInstanceOf(UploadStreamError);

    const second = new DurableStagingStore(join(directory, 'safe'), 64, 80);
    await second.initialize();
    const target = second.pathForKey('uploads/ff/001122');
    await mkdir(target, {recursive: true});
    await expect(second.verify('uploads/ff/001122', 0, digest(''))).rejects.toMatchObject({
      failureCode: 'STAGING_PATH_INVALID'
    });
  });
});
