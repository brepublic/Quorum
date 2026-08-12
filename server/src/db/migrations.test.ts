// @vitest-environment node

import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadMigrations} from './migrations';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'quorum-migrations-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('migration discovery', () => {
  it('loads migrations in version order with stable checksums', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;\n');
    await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;\n');

    const migrations = await loadMigrations(directory);
    expect(migrations.map(item => item.version)).toEqual([1, 2]);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects SQL files outside the versioned naming contract', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'first.sql'), 'SELECT 1;\n');

    await expect(loadMigrations(directory)).rejects.toThrow('Invalid migration filename');
  });
});
