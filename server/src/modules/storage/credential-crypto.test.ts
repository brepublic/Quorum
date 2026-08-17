// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {StorageCredentialCipher} from './credential-crypto';

describe('storage credential encryption', () => {
  it('uses versioned authenticated encryption without plaintext ciphertext', () => {
    const id = randomUUID();
    const cipher = new StorageCredentialCipher(Buffer.alloc(32, 1), 4);
    const encrypted = cipher.encrypt(id, {accessKeyId: 'access-key', secretAccessKey: 'secret-key'});
    expect(encrypted.keyVersion).toBe(4);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('secret-key');
    expect(cipher.decrypt(id, encrypted)).toEqual({accessKeyId: 'access-key', secretAccessKey: 'secret-key'});
  });

  it('rejects a missing or wrong key, tampering, and cross-config replay', () => {
    const id = randomUUID();
    const encrypted = new StorageCredentialCipher(Buffer.alloc(32, 2), 1)
      .encrypt(id, {accessKeyId: 'access', secretAccessKey: 'secret'});
    expect(() => new StorageCredentialCipher(null, 1).decrypt(id, encrypted)).toThrow('cannot be decrypted');
    expect(() => new StorageCredentialCipher(Buffer.alloc(32, 3), 1).decrypt(id, encrypted)).toThrow('cannot be decrypted');
    const tampered = {...encrypted, ciphertext: Buffer.from(encrypted.ciphertext)};
    tampered.ciphertext[0] ^= 1;
    expect(() => new StorageCredentialCipher(Buffer.alloc(32, 2), 1).decrypt(id, tampered)).toThrow('cannot be decrypted');
    expect(() => new StorageCredentialCipher(Buffer.alloc(32, 2), 1)
      .decrypt(randomUUID(), encrypted)).toThrow('cannot be decrypted');
  });
});
