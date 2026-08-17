// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {DurableStagingStore} from './staging';
import {S3CompatibleStore, signS3Headers, type S3Request, type S3Response, type S3Transport} from './s3-store';

const roots: string[] = [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const empty = async function* () {};

async function fixture(content = 's3-compatible-content') {
  const root = await mkdtemp(join(tmpdir(), 'quorum-s3-staging-'));
  roots.push(root);
  const staging = new DurableStagingStore(root, 1024, 2048);
  await staging.initialize();
  const stagingKey = `uploads/aa/${randomUUID().replaceAll('-', '')}`;
  await staging.write({key: stagingKey, source: (async function* () { yield content; })(),
    expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
  return {staging, stagingKey, content};
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

class MemoryTransport implements S3Transport {
  readonly objects = new Map<string, Buffer>();
  readonly requests: S3Request[] = [];
  failPut = false;
  corruptReads = false;
  deleteStatus = 204;

  async request(input: S3Request): Promise<S3Response> {
    this.requests.push(input);
    if (input.method === 'PUT') {
      if (this.failPut) throw new Error('network interrupted');
      const chunks: Buffer[] = [];
      for await (const chunk of input.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      this.objects.set(input.key, Buffer.concat(chunks));
      return {statusCode: 200, headers: {}, body: empty()};
    }
    if (input.method === 'GET') {
      const content = this.corruptReads ? Buffer.from('corrupt') : this.objects.get(input.key);
      return {statusCode: content ? 200 : 404, headers: {}, body: (async function* () {
        if (content) yield content;
      })()};
    }
    if (this.deleteStatus !== 404) this.objects.delete(input.key);
    return {statusCode: this.deleteStatus, headers: {}, body: empty()};
  }
}

function store(transport: S3Transport): S3CompatibleStore {
  return new S3CompatibleStore({endpoint: 'https://s3.example.com', region: 'ap-shanghai',
    bucket: 'quorum-files', prefix: 'instance', forcePathStyle: true, allowPrivateNetwork: false,
    credentials: {accessKeyId: 'access', secretAccessKey: 'secret'}}, transport, 1024);
}

describe('S3 compatible provider', () => {
  it('matches the AWS S3 SigV4 GET object test vector', () => {
    const payloadHash = digest('');
    const headers = signS3Headers({method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1', credentials: {accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'},
      payloadHash, date: new Date('2013-05-24T00:00:00.000Z'), extra: {range: 'bytes=0-9'}});
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/'
      + '20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('streams staging to a blob-derived object and re-reads it for verification', async () => {
    const {staging, stagingKey, content} = await fixture();
    const transport = new MemoryTransport();
    const provider = store(transport);
    const blobId = randomUUID();
    const committed = await provider.commitFromStaging({blobId, staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    expect(committed.storageKey).toMatch(/^instance\/blobs\/[a-f0-9]{2}\/[a-f0-9]{32}$/);
    expect(transport.requests.map(request => request.method)).toEqual(['PUT', 'GET']);
    expect(transport.requests[0]).toEqual(expect.objectContaining({
      contentLength: Buffer.byteLength(content), sha256: digest(content)
    }));
    expect(await staging.exists(stagingKey)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const chunk of provider.read(committed.storageKey, committed.sizeBytes, committed.sha256)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it('keeps staging when upload or remote verification fails', async () => {
    const {staging, stagingKey, content} = await fixture();
    const transport = new MemoryTransport();
    const provider = store(transport);
    transport.failPut = true;
    await expect(provider.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)})).rejects.toMatchObject({
      failureCode: 'S3_WRITE_FAILED'
    });
    expect(await staging.exists(stagingKey)).toBe(true);
    transport.failPut = false;
    transport.corruptReads = true;
    await expect(provider.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)})).rejects.toMatchObject({
      failureCode: 'S3_INTEGRITY_MISMATCH'
    });
    expect(await staging.exists(stagingKey)).toBe(true);
  });

  it('supports an explicit deletion primitive without deleting staging', async () => {
    const {staging, stagingKey, content} = await fixture();
    const transport = new MemoryTransport();
    const provider = store(transport);
    const committed = await provider.commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: Buffer.byteLength(content), expectedSha256: digest(content)});
    await provider.delete(committed.storageKey);
    expect(transport.objects.has(committed.storageKey)).toBe(false);
    expect(await staging.exists(stagingKey)).toBe(true);
  });

  it('treats an already missing object as an idempotent delete success', async () => {
    const transport = new MemoryTransport();
    transport.deleteStatus = 404;
    await expect(store(transport).delete('instance/blobs/aa/' + 'a'.repeat(32))).resolves.toBeUndefined();
  });

  it('rejects a declared object above the provider file limit before transport', async () => {
    const {staging, stagingKey} = await fixture();
    const transport = new MemoryTransport();
    await expect(store(transport).commitFromStaging({blobId: randomUUID(), staging, stagingKey,
      expectedSizeBytes: 1025, expectedSha256: 'a'.repeat(64)})).rejects.toMatchObject({
      failureCode: 'S3_INPUT_INVALID'
    });
    expect(transport.requests).toHaveLength(0);
  });
});
