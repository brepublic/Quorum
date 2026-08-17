// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {cp, mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {migrationStatus, runMigrations} from './migrations';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let databaseUrl = '';
const temporaryDirectories: string[] = [];

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
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
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

      expect(first).toEqual(expect.objectContaining({ready: true, latestAppliedVersion: 39}));
      expect(second).toEqual(expect.objectContaining({ready: true, pendingVersions: []}));
      expect(status.ready).toBe(true);
      expect(runtime.rows[0]?.schema_compatibility).toBe(39);
      expect(applied.rowCount).toBe(39);
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
      const stage6Tables = await pool.query<{name: string}>(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('storage_bindings','file_entries','file_versions',
        'file_blobs','file_tombstones','file_uploads','storage_provider_configs','file_blob_delete_jobs',
        'storage_migrations','storage_migration_items','file_blob_copies','storage_cleanup_audit')`);
      expect(stage6Tables.rowCount).toBe(12);
      const stage7Tables = await pool.query<{name: string}>(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
          ('storage_pairing_codes','storage_hosts','storage_manifest_events','storage_agent_tasks',
           'storage_agent_change_requests','storage_agent_conflicts','storage_agent_conflict_applications')`);
      expect(stage7Tables.rowCount).toBe(7);
      const stage8Tables = await pool.query<{name: string}>(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
          ('committee_deletion_jobs','committee_deletion_agent_tasks')`);
      expect(stage8Tables.rowCount).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('backfills one audited main speakers list for an existing open meeting before enforcing uniqueness', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0038-'));
    temporaryDirectories.push(staged);
    const files = (await readdir(source)).filter(file => file.endsWith('.sql')).sort();
    for (const file of files.filter(file => Number(file.slice(0, 4)) <= 37)) {
      await cp(join(source, file), join(staged, file));
    }
    const userId = randomUUID(); const packageId = randomUUID(); const versionId = randomUUID();
    const committeeId = randomUUID(); const meetingId = randomUUID();
    try {
      await runMigrations(pool, staged);
      await pool.query(`INSERT INTO users (id,email,display_name,status,is_system_admin,must_change_password)
        VALUES ($1,'migration-owner@example.test','Migration Owner','ACTIVE',false,false)`, [userId]);
      await pool.query(`INSERT INTO rule_packages (id,scope,stable_key) VALUES ($1,'BUILTIN','test:0038')`, [packageId]);
      await pool.query(`INSERT INTO rule_package_versions
        (id,package_id,version,status,definition,schema_version,published_at)
        VALUES ($1,$2,1,'PUBLISHED',$3,1,now())`, [versionId, packageId, {
        speakerLists: [{id: 'general-speakers-list', defaultDurationSeconds: 75}]
      }]);
      await pool.query(`INSERT INTO committees
        (id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id)
        VALUES ($1,$2,'Migration Committee','PRIVATE','CHAIR_OPERATED',$3)`, [committeeId, userId, versionId]);
      await pool.query(`INSERT INTO meeting_sessions
        (id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id)
        VALUES ($1,$2,'open-debate',$3,$4)`, [meetingId, committeeId, versionId, userId]);

      const migration38 = files.find(file => file.startsWith('0038_')) as string;
      await cp(join(source, migration38), join(staged, migration38));
      const status = await runMigrations(pool, staged);
      expect(status.latestAppliedVersion).toBe(38);

      const lists = await pool.query<{id: string; default_speech_ms: string; remaining_at_start_ms: string}>(`SELECT
        list.id,list.default_speech_ms,timer.remaining_at_start_ms FROM speaker_lists list
        JOIN timer_states timer ON timer.id=list.speech_timer_id
        WHERE list.meeting_session_id=$1 AND list.kind='GENERAL'`, [meetingId]);
      expect(lists.rows).toEqual([expect.objectContaining({default_speech_ms: '75000', remaining_at_start_ms: '75000'})]);
      const event = await pool.query<{payload: {migrationBackfill?: boolean}}>(`SELECT payload FROM committee_events
        WHERE committee_id=$1 AND event_type='speaker_list.created'`, [committeeId]);
      expect(event.rows[0]?.payload.migrationBackfill).toBe(true);
      const audit = await pool.query<{action: string; actor_user_id: string | null}>(`SELECT action,actor_user_id FROM audit_log
        WHERE committee_id=$1 AND resource_id=$2`, [committeeId, lists.rows[0]?.id]);
      expect(audit.rows).toEqual([{action: 'migration.main_speaker_list_backfilled', actor_user_id: null}]);
      const index = await pool.query<{indexdef: string}>(`SELECT indexdef FROM pg_indexes
        WHERE indexname='speaker_lists_one_general_per_session'`);
      expect(index.rows[0]?.indexdef).toContain("WHERE (kind = 'GENERAL'::speaker_list_kind)");
    } finally {
      await pool.end();
    }
  });
});
