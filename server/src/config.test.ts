// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {loadConfig} from './config';

describe('server configuration', () => {
  it('accepts a complete DATABASE_URL', () => {
    expect(loadConfig({DATABASE_URL: 'postgresql://localhost/quorum'}).databaseUrl)
      .toBe('postgresql://localhost/quorum');
  });

  it('safely encodes separate database credentials', () => {
    const config = loadConfig({
      DB_HOST: 'postgres',
      DB_PORT: '5432',
      DB_NAME: 'quorum',
      DB_USER: 'quorum@example',
      DB_PASSWORD: 'p@ss:/word'
    });

    expect(config.databaseUrl).toBe('postgresql://quorum%40example:p%40ss%3A%2Fword@postgres:5432/quorum');
  });

  it('rejects incomplete database configuration', () => {
    expect(() => loadConfig({DB_HOST: 'postgres'})).toThrow('must be configured');
  });

  it('accepts only exact HTTP origins for CSRF protection', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/quorum',
      QUORUM_ALLOWED_ORIGINS: 'https://quorum.example.com,http://localhost:5173'
    });
    expect(config.allowedOrigins).toEqual(['https://quorum.example.com', 'http://localhost:5173']);
    expect(() => loadConfig({DATABASE_URL: 'postgresql://localhost/quorum',
      QUORUM_ALLOWED_ORIGINS: 'https://quorum.example.com/path'})).toThrow('HTTP origins');
  });

  it('keeps the global upload request limit above the file limit', () => {
    const config = loadConfig({DATABASE_URL: 'postgresql://localhost/quorum'});
    expect(config.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(config.maxUploadRequestBytes).toBe(21 * 1024 * 1024);
    expect(config.uploadTtlSeconds).toBe(24 * 60 * 60);
    expect(() => loadConfig({DATABASE_URL: 'postgresql://localhost/quorum',
      QUORUM_MAX_FILE_BYTES: '20', QUORUM_MAX_UPLOAD_REQUEST_BYTES: '19'}))
      .toThrow('must be at least');
  });

  it('accepts only an explicit 32-byte storage master key', () => {
    const encoded = Buffer.alloc(32, 7).toString('base64url');
    const config = loadConfig({DATABASE_URL: 'postgresql://localhost/quorum',
      QUORUM_STORAGE_MASTER_KEY: encoded, QUORUM_STORAGE_MASTER_KEY_VERSION: '3'});
    expect(config.storageMasterKey).toEqual(Buffer.alloc(32, 7));
    expect(config.storageMasterKeyVersion).toBe(3);
    expect(loadConfig({DATABASE_URL: 'postgresql://localhost/quorum'}).storageMasterKey).toBeNull();
    expect(() => loadConfig({DATABASE_URL: 'postgresql://localhost/quorum',
      QUORUM_STORAGE_MASTER_KEY: 'not-a-key'})).toThrow('32-byte key');
  });
});
