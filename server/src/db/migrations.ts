import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool, PoolClient} from 'pg';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  ready: boolean;
  latestAvailableVersion: number;
  latestAppliedVersion: number;
  pendingVersions: number[];
  unknownAppliedVersions: number[];
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const MIGRATION_LOCK_ID = 7_641_903_421;

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
  const migrations = await Promise.all(files.map(async file => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}`);
    }
    const version = Number(match[1]);
    const sql = await readFile(join(directory, file), 'utf8');
    return {
      version,
      name: match[2] as string,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex')
    };
  }));

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS quorum_meta');
  await client.query(`
    CREATE TABLE IF NOT EXISTS quorum_meta.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(pool: Pool, directory: string): Promise<MigrationStatus> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  let locked = false;
  try {
    await ensureMigrationTable(client);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    const appliedResult = await client.query<{version: number; checksum: string}>(
      'SELECT version, checksum FROM quorum_meta.schema_migrations ORDER BY version'
    );
    const applied = new Map(appliedResult.rows.map(row => [row.version, row.checksum]));

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum && existingChecksum !== migration.checksum) {
        throw new Error(`Migration ${migration.version} checksum does not match the applied migration.`);
      }
      if (existingChecksum) {
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO quorum_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }

  return migrationStatus(pool, directory);
}

export async function migrationStatus(pool: Pool, directory: string): Promise<MigrationStatus> {
  const migrations = await loadMigrations(directory);
  const latestAvailableVersion = migrations.at(-1)?.version ?? 0;
  const exists = await pool.query<{migration_table: string | null}>(
    "SELECT to_regclass('quorum_meta.schema_migrations')::text AS migration_table"
  );
  if (!exists.rows[0]?.migration_table) {
    return {
      ready: migrations.length === 0,
      latestAvailableVersion,
      latestAppliedVersion: 0,
      pendingVersions: migrations.map(migration => migration.version),
      unknownAppliedVersions: []
    };
  }

  const appliedResult = await pool.query<{version: number; checksum: string}>(
    'SELECT version, checksum FROM quorum_meta.schema_migrations ORDER BY version'
  );
  const applied = new Map(appliedResult.rows.map(row => [row.version, row.checksum]));
  const availableVersions = new Set(migrations.map(migration => migration.version));
  const unknownAppliedVersions = appliedResult.rows
    .map(row => row.version)
    .filter(version => !availableVersions.has(version));
  const pendingVersions: number[] = [];
  for (const migration of migrations) {
    const checksum = applied.get(migration.version);
    if (checksum && checksum !== migration.checksum) {
      throw new Error(`Migration ${migration.version} checksum does not match the applied migration.`);
    }
    if (!checksum) {
      pendingVersions.push(migration.version);
    }
  }

  return {
    ready: pendingVersions.length === 0 && unknownAppliedVersions.length === 0,
    latestAvailableVersion,
    latestAppliedVersion: appliedResult.rows.at(-1)?.version ?? 0,
    pendingVersions,
    unknownAppliedVersions
  };
}
