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
});
