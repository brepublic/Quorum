import {describe, expect, it, vi} from 'vitest';
import {IncrementalSha256, sha256File} from './sha256';

describe('incremental browser SHA-256', () => {
  it('matches standard vectors across incremental block boundaries', () => {
    const hash = new IncrementalSha256();
    hash.update(new TextEncoder().encode('a'));
    hash.update(new TextEncoder().encode('bc'));
    expect(hash.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a Blob in bounded chunks and reports real byte progress', async () => {
    const progress = vi.fn();
    const value = await sha256File(new Blob(['abcdef']), {chunkBytes: 2, onProgress: progress});
    expect(value).toBe('bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
    expect(progress.mock.calls).toEqual([[0, 6], [2, 6], [4, 6], [6, 6]]);
  });

  it('stops between chunks when cancelled', async () => {
    const controller = new AbortController();
    await expect(sha256File(new Blob(['abcdef']), {chunkBytes: 2, onProgress(processed) {
      if (processed === 2) controller.abort();
    }, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
  });
});
