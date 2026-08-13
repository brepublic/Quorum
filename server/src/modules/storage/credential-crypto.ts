import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {AppError} from '../../http/errors.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface EncryptedCredentials {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

function credentials(value: unknown): S3Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 credentials are invalid.'});
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['accessKeyId', 'secretAccessKey'].includes(key))
    || typeof record.accessKeyId !== 'string' || record.accessKeyId.length < 1 || record.accessKeyId.length > 256
    || typeof record.secretAccessKey !== 'string' || record.secretAccessKey.length < 1
    || record.secretAccessKey.length > 512) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 credentials are invalid.'});
  }
  return {accessKeyId: record.accessKeyId, secretAccessKey: record.secretAccessKey};
}

function aad(configId: string, version: number): Buffer {
  return Buffer.from(`quorum:s3-provider-config:${configId}:v${version}`, 'utf8');
}

export class StorageCredentialCipher {
  constructor(private readonly key: Buffer | null, readonly keyVersion: number) {
    if (key && key.length !== 32) throw new Error('Storage credential key must contain 32 bytes.');
  }

  get available(): boolean {
    return this.key !== null;
  }

  encrypt(configId: string, value: unknown): EncryptedCredentials {
    if (!this.key) throw new AppError({code: 'SERVICE_NOT_READY', message: 'Storage credential encryption is not configured.'});
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(configId, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials(value)), 'utf8'), cipher.final()]);
    return {ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: this.keyVersion};
  }

  decrypt(configId: string, encrypted: EncryptedCredentials): S3Credentials {
    if (!this.key || encrypted.keyVersion !== this.keyVersion) {
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'Storage credentials cannot be decrypted.'});
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.nonce);
      decipher.setAAD(aad(configId, encrypted.keyVersion));
      decipher.setAuthTag(encrypted.authTag);
      const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
      return credentials(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'Storage credentials cannot be decrypted.'});
    }
  }
}
