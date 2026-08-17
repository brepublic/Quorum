// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {assertS3NetworkAddress, s3ObjectKey, validateS3Endpoint} from './s3-endpoint';

const valid = {endpoint: 'https://cos.example.com', region: 'ap-shanghai', bucket: 'quorum-files',
  prefix: 'quorum/production', forcePathStyle: true, allowPrivateNetwork: false};

describe('S3 endpoint and object keys', () => {
  it('accepts a strict HTTPS endpoint and derives keys only from blob IDs', () => {
    expect(validateS3Endpoint(valid)).toEqual(valid);
    const blobId = randomUUID();
    expect(s3ObjectKey(valid.prefix, blobId)).toMatch(/^quorum\/production\/blobs\/[a-f0-9]{2}\/[a-f0-9]{32}$/);
    expect(s3ObjectKey(valid.prefix, blobId)).not.toContain('user-file');
  });

  it.each([
    'http://cos.example.com',
    'https://user:secret@cos.example.com',
    'https://cos.example.com?target=other',
    'https://cos.example.com/#fragment',
    'https://localhost',
    'https://127.0.0.1',
    'https://169.254.169.254'
  ])('rejects unsafe endpoint %s', endpoint => {
    expect(() => validateS3Endpoint({...valid, endpoint})).toThrow();
  });

  it('rejects private resolved addresses unless the administrator explicitly allowed them', () => {
    expect(() => assertS3NetworkAddress('10.0.0.8', false)).toThrow('disallowed');
    expect(() => assertS3NetworkAddress('::1', false)).toThrow('disallowed');
    expect(() => assertS3NetworkAddress('ff02::1', false)).toThrow('disallowed');
    expect(() => assertS3NetworkAddress('::ffff:a00:1', false)).toThrow('disallowed');
    expect(() => assertS3NetworkAddress('10.0.0.8', true)).not.toThrow();
    expect(() => assertS3NetworkAddress('8.8.8.8', false)).not.toThrow();
  });

  it('rejects prefix traversal and invalid blob IDs', () => {
    expect(() => validateS3Endpoint({...valid, prefix: '../escape'})).toThrow('prefix');
    expect(() => s3ObjectKey('safe', '../../file')).toThrow('Blob ID');
  });
});
