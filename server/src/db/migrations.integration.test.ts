// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {migrationStatus, runMigrations} from './migrations';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let databaseUrl = '';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  const client = new Client({connectionString: adminUrl});
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
});

afterEach(async () => {
  if (!adminUrl || !databaseName) return;
  const client = new Client({connectionString: adminUrl});
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
    databaseName = '';
  }
});

integration('PostgreSQL migrations', () => {
  it('migrates an empty database and is safe to run again', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const migrationsDirectory = resolve('server/migrations');
    try {
      const first = await runMigrations(pool, migrationsDirectory);
      const second = await runMigrations(pool, migrationsDirectory);
      const status = await migrationStatus(pool, migrationsDirectory);
      const runtime = await pool.query<{schema_compatibility: number}>(
        'SELECT schema_compatibility FROM quorum_meta.runtime_metadata WHERE singleton = true'
      );
      const applied = await pool.query('SELECT version FROM quorum_meta.schema_migrations');

      expect(first).toEqual(expect.objectContaining({ready: true, latestAppliedVersion: 10}));
      expect(second).toEqual(expect.objectContaining({ready: true, pendingVersions: []}));
      expect(status.ready).toBe(true);
      expect(runtime.rows[0]?.schema_compatibility).toBe(11);
      expect(applied.rowCount).toBe(11);
      const stage3Tables = await pool.query<{name: string}>(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('committees','committee_memberships','committee_capabilities',
        'committee_seats','seat_assignments','seat_invitations','rule_packages','rule_package_versions',
        'committee_rule_bindings','chair_rule_overrides','committee_events','audit_log')`);
      expect(stage3Tables.rowCount).toBe(12);
      const stage4Tables = await pool.query<{name: string}>(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('country_templates','country_template_countries',
        'committee_templates','committee_template_members','committee_notes','committee_text_posts',
        'meeting_sessions','roll_calls','roll_call_seats','roll_call_entries','attendance_events',
        'current_attendance','points','idempotency_keys')`);
      expect(stage4Tables.rowCount).toBe(14);
    } finally {
      await pool.end();
    }
  });
});
