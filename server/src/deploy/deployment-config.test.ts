// @vitest-environment node

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const composePath = 'deploy/compose.yaml';
const caddyfilePath = 'deploy/Caddyfile';

describe('self-hosted deployment configuration', () => {
  it('keeps PostgreSQL on the internal network and uses persistent named volumes', async () => {
    const compose = await readFile(composePath, 'utf8');
    const postgresBlock = compose.match(/\n  postgres:\n([\s\S]*?)(?=\nvolumes:)/)?.[1] ?? '';

    expect(postgresBlock).not.toMatch(/^\s{4}ports:/m);
    expect(postgresBlock).toContain('postgres_data:/var/lib/postgresql/data');
    expect(compose).toContain('quorum_files:/var/lib/quorum/files');
    expect(compose).toContain('QUORUM_STORAGE_PATH: /var/lib/quorum/files');
    expect(compose).toContain('QUORUM_MAX_FILE_BYTES:');
    expect(compose).toContain('QUORUM_MAX_UPLOAD_REQUEST_BYTES:');
    expect(compose).toMatch(/\nvolumes:\n(?:\s{2}[a-z_]+:\n?)+$/);
  });

  it('defines health checks and memory ceilings for the target host', async () => {
    const compose = await readFile(composePath, 'utf8');

    expect(compose).toMatch(/app:[\s\S]*?healthcheck:[\s\S]*?\/health\/ready/);
    expect(compose).toMatch(/postgres:[\s\S]*?healthcheck:[\s\S]*?pg_isready/);
    expect(compose.match(/mem_limit:/g)).toHaveLength(3);
  });

  it('routes API and health requests before the SPA fallback', async () => {
    const caddyfile = await readFile(caddyfilePath, 'utf8');
    const api = caddyfile.indexOf('handle /api/v1/*');
    const health = caddyfile.indexOf('handle /health/*');
    const spa = caddyfile.indexOf('try_files {path} /index.html');

    expect(api).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(api);
    expect(spa).toBeGreaterThan(health);
    expect(caddyfile).toContain('reverse_proxy app:3000');
  });
});
