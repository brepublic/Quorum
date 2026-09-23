// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
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
  it('upgrades schema 66 single-country drafts without losing countries or rewriting history', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0067-')); temporaryDirectories.push(staged);
    const userId=randomUUID(), committeeId=randomUUID(), packageId=randomUUID(), ruleId=randomUUID();
    const sessionId=randomUUID(), documentId=randomUUID(), emptyId=randomUUID(), first=randomUUID(), second=randomUUID();
    const historyId=randomUUID();
    try {
      for (const file of (await readdir(source)).filter(file=>file.endsWith('.sql') && Number(file.slice(0,4))<=66))
        await cp(join(source,file),join(staged,file));
      await runMigrations(pool,staged);
      await pool.query(`INSERT INTO users(id,email,display_name,status,is_system_admin,must_change_password)
        VALUES($1,'countries@example.test','Countries','ACTIVE',false,false)`,[userId]);
      await pool.query("INSERT INTO rule_packages(id,scope,stable_key) VALUES($1,'BUILTIN','countries-test')",[packageId]);
      await pool.query(`INSERT INTO rule_package_versions(id,package_id,version,status,definition,schema_version,published_at)
        VALUES($1,$2,1,'PUBLISHED','{}',1,now())`,[ruleId,packageId]);
      const countries = ['China','France'].map((name,index) => ({stableKey:name, names:{en:name}, flag:{type:'STANDARD',value:index?'fr':'cn'}}));
      await pool.query(`INSERT INTO committees(id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id,content_snapshot,committee_language)
        VALUES($1,$2,'Countries','PRIVATE','CHAIR_OPERATED',$3,$4,'en')`,[committeeId,userId,ruleId,
          {schemaVersion:1,countryTemplate:{countries},committeeTemplate:null,initialRulePackageVersionId:ruleId}]);
      for (const [index,id] of [first,second].entries()) await pool.query(`INSERT INTO committee_seats
        (id,committee_id,stable_key,display_name,rank,flag_type,flag_value) VALUES($1,$2,$3,$3,'STANDARD','STANDARD',$4)`,
      [id,committeeId,countries[index].stableKey,countries[index].flag.value]);
      await pool.query(`INSERT INTO meeting_sessions(id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id)
        VALUES($1,$2,'formal-debate',$3,$4)`,[sessionId,committeeId,ruleId,userId]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const id of [documentId,emptyId]) {
          const versionId = randomUUID();
          await client.query(`INSERT INTO documents(id,committee_id,meeting_session_id,kind,rule_package_version_id,created_by_user_id,current_version_id)
            VALUES($1,$2,$3,'RESOLUTION',$4,$5,$6)`,[id,committeeId,sessionId,ruleId,userId,versionId]);
          await client.query(`INSERT INTO document_versions(id,document_id,version_number,content,created_by_user_id)
            VALUES($1,$2,1,'',$3)`, [versionId,id,userId]);
          await client.query('INSERT INTO resolutions(document_id,proposer_seat_id,seconder_seat_id) VALUES($1,$2,$3)',
            [id,id===documentId?first:null,id===documentId?second:null]);
        }
        await client.query('COMMIT');
      } catch (error) {await client.query('ROLLBACK'); throw error;}
      finally {client.release();}
      const history={proposerSeatId:first,seconderSeatId:second};
      await pool.query(`INSERT INTO resolution_setting_revisions(id,committee_id,resolution_document_id,before_value,after_value,actor_user_id)
        VALUES($1,$2,$3,'{}',$4,$5)`,[historyId,committeeId,documentId,history,userId]);
      await cp(join(source,'0067_resolution_countries.sql'),join(staged,'0067_resolution_countries.sql'));
      expect((await runMigrations(pool,staged)).latestAppliedVersion).toBe(67);
      expect((await pool.query('SELECT seat_id,role FROM resolution_countries WHERE resolution_document_id=$1 ORDER BY role', [documentId])).rows)
        .toEqual([{seat_id:first,role:'PROPOSER'},{seat_id:second,role:'SECONDER'}]);
      expect((await pool.query('SELECT * FROM resolution_countries WHERE resolution_document_id=$1', [emptyId])).rows).toEqual([]);
      expect((await pool.query('SELECT after_value FROM resolution_setting_revisions WHERE id=$1', [historyId])).rows[0].after_value).toEqual(history);
    } finally {await pool.end();}
  });

  it('stops the formal-name upgrade with conflicting file IDs instead of merging them', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0066-')); temporaryDirectories.push(staged);
    const userId=randomUUID(), committeeId=randomUUID(), packageId=randomUUID(), ruleId=randomUUID(), bindingId=randomUUID();
    const fileIds=[randomUUID(),randomUUID()];
    try {
      for (const file of (await readdir(source)).filter(file=>file.endsWith('.sql') && Number(file.slice(0,4))<=65))
        await cp(join(source,file),join(staged,file));
      await runMigrations(pool,staged);
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO users(id,email,display_name,status,is_system_admin,must_change_password)
          VALUES($1,'formal@example.test','Formal','ACTIVE',false,false)`,[userId]);
        await client.query("INSERT INTO rule_packages(id,scope,stable_key) VALUES($1,'BUILTIN','formal-test')",[packageId]);
        await client.query(`INSERT INTO rule_package_versions(id,package_id,version,status,definition,schema_version,published_at)
          VALUES($1,$2,1,'PUBLISHED','{}',1,now())`,[ruleId,packageId]);
        await client.query(`INSERT INTO committees(id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id,content_snapshot,committee_language)
          VALUES($1,$2,'Formal','PRIVATE','CHAIR_OPERATED',$3,$4,'en')`,[committeeId,userId,ruleId,
            {schemaVersion:1,countryTemplate:{countries:[]},committeeTemplate:null,initialRulePackageVersionId:ruleId}]);
        await client.query(`INSERT INTO storage_bindings(id,committee_id,provider_type,status,created_by_user_id)
          VALUES($1,$2,'SERVER_VOLUME','ACTIVE',$3)`,[bindingId,committeeId,userId]);
        for (const [index,fileId] of fileIds.entries()) {
          const versionId=randomUUID(),blobId=randomUUID();
          await client.query(`INSERT INTO file_blobs(id,committee_id,storage_binding_id,storage_key,size_bytes,sha256,durability_state)
            VALUES($1,$2,$3,$4,1,$5,'COMMITTED')`,[blobId,committeeId,bindingId,`blobs/${blobId}`,Buffer.alloc(32,1)]);
          await client.query(`INSERT INTO file_entries(id,committee_id,logical_name,media_type,status,current_version_id,created_by_user_id,published_at,submitted_at,published_by_user_id)
            VALUES($1,$2,$3,'text/plain','PUBLISHED',$4,$5,now(),now(),$5)`,[fileId,committeeId,index?'\u3000Official\u00a0':'Official',versionId,userId]);
          await client.query(`INSERT INTO file_versions(id,committee_id,file_entry_id,version_number,blob_id,original_name,media_type,size_bytes,sha256,created_by_user_id)
            VALUES($1,$2,$3,1,$4,'source.txt','text/plain',1,$5,$6)`,[versionId,committeeId,fileId,blobId,Buffer.alloc(32,1),userId]);
        }
        await client.query('COMMIT');
      } finally {client.release();}
      await cp(join(source,'0066_formal_file_names.sql'),join(staged,'0066_formal_file_names.sql'));
      let failure:unknown;try {await runMigrations(pool,staged);} catch(error) {failure=error;}
      expect(String(failure)).toContain('Formal file name conflicts require review');
      for(const id of fileIds) expect(String(failure)).toContain(id);
      expect((await pool.query('SELECT count(*)::int AS count FROM file_entries')).rows[0].count).toBe(2);
      expect((await migrationStatus(pool,staged)).latestAppliedVersion).toBe(65);
    } finally {await pool.end();}
  });


  it('upgrades schema 42 with default committee behavior values and formal-debate baseline', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations'); const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0043-'));
    temporaryDirectories.push(staged);
    const files = (await readdir(source)).filter(file => file.endsWith('.sql')).sort();
    try {
      for (const file of files.filter(file => Number(file.slice(0, 4)) <= 42)) await cp(join(source, file), join(staged, file));
      await runMigrations(pool, staged);
      await cp(join(source, files.find(file => file.startsWith('0043_')) as string), join(staged, '0043_default_committee_behavior.sql'));
      await cp(join(source, files.find(file => file.startsWith('0044_')) as string), join(staged, '0044_formal_debate_general_list_continuity.sql'));
      const applied = await runMigrations(pool, staged);
      const defaults = await pool.query(`SELECT default_committee_creator_is_chair, default_committee_operation_mode,
        default_committee_behavior_revision FROM system_settings WHERE singleton=true`);
      expect(applied.latestAppliedVersion).toBe(44);
      expect(defaults.rows).toEqual([{default_committee_creator_is_chair: true, default_committee_operation_mode: 'CHAIR_OPERATED',
        default_committee_behavior_revision: 1}]);
      await expect(pool.query(`UPDATE system_settings SET default_committee_behavior_revision=0 WHERE singleton=true`)).rejects.toMatchObject({code: '23514'});
    } finally { await pool.end(); }
  });

  it('upgrades legacy seat ranks without rewriting formal snapshots or audit records', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations'); const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0054-'));
    temporaryDirectories.push(staged);
    const files = (await readdir(source)).filter(file => file.endsWith('.sql')).sort();
    const userId = randomUUID(), committeeId = randomUUID(), packageId = randomUUID(), versionId = randomUUID();
    const seatId = randomUUID(), templateId = randomUUID(), meetingId = randomUUID(), ballotId = randomUUID();
    try {
      for (const file of files.filter(file => Number(file.slice(0, 4)) <= 53)) await cp(join(source, file), join(staged, file));
      await runMigrations(pool, staged);
      await pool.query(`INSERT INTO users (id,email,display_name,status,is_system_admin,must_change_password)
        VALUES ($1,'migration@example.test','Migration','ACTIVE',false,false)`, [userId]);
      await pool.query(`INSERT INTO rule_packages (id,scope,stable_key) VALUES ($1,'BUILTIN','test:0054')`, [packageId]);
      await pool.query(`INSERT INTO rule_package_versions (id,package_id,version,status,definition,schema_version,published_at)
        VALUES ($1,$2,1,'PUBLISHED','{}',1,now())`, [versionId, packageId]);
      await pool.query(`INSERT INTO committees (id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id)
        VALUES ($1,$2,'Migration','PRIVATE','CHAIR_OPERATED',$3)`, [committeeId, userId, versionId]);
      await pool.query(`INSERT INTO committee_seats (id,committee_id,stable_key,display_name,rank,can_vote,has_veto,must_vote)
        VALUES ($1,$2,'one','One','VETO',true,true,true)`, [seatId, committeeId]);
      await pool.query(`INSERT INTO committee_templates (id,owner_user_id,names,default_language,country_template_key)
        VALUES ($1,$2,'{"en":"Migration"}','en','builtin:default')`, [templateId, userId]);
      await pool.query(`INSERT INTO committee_template_members
        (id,committee_template_id,stable_key,names,default_language,rank,can_vote,has_veto,must_vote,flag_type,flag_value)
        VALUES ($1,$2,'one','{"en":"One"}','en','VETO',true,false,false,'EMOJI','🏳️')`, [randomUUID(), templateId]);
      await pool.query(`INSERT INTO meeting_sessions (id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id,name)
        VALUES ($1,$2,'debate',$3,$4,'第1会期')`, [meetingId, committeeId, versionId, userId]);
      await pool.query(`INSERT INTO ballots (id,committee_id,meeting_session_id,subject_type,subject_id,procedural,choices,
        rule_package_version_id,rule_evaluation,eligibility_snapshot,threshold_definition,threshold_value,opened_by_user_id)
        VALUES ($1,$2,$3,'MOTION',$4,false,'{FOR,AGAINST,ABSTAIN}',$5,'{}',$6,'{}',1,$7)`,
      [ballotId, committeeId, meetingId, randomUUID(), versionId,
        JSON.stringify([{seatId, seatDisplayName: 'One', hasVeto: true, mustVote: true}]), userId]);
      await pool.query(`INSERT INTO audit_log (id,request_id,committee_id,action,resource_type,result,after_summary)
        VALUES ($1,'migration-history',$2,'committee.seat_created','seat','SUCCEEDED','{"rank":"VETO","hasVeto":true}')`,
      [randomUUID(), committeeId]);
      const history = (await pool.query('SELECT * FROM audit_log')).rows;
      const ballots = (await pool.query('SELECT * FROM ballots')).rows;
      const migration = files.find(file => file.startsWith('0054_'))!;
      await cp(join(source, migration), join(staged, migration));
      expect((await runMigrations(pool, staged)).latestAppliedVersion).toBe(54);
      expect((await pool.query('SELECT rank,can_vote,has_veto,must_vote FROM committee_seats')).rows)
        .toEqual([{rank: 'STANDARD', can_vote: true, has_veto: true, must_vote: true}]);
      expect((await pool.query('SELECT rank,has_veto FROM committee_template_members')).rows)
        .toEqual([{rank: 'STANDARD', has_veto: false}]);
      expect((await pool.query('SELECT * FROM audit_log')).rows).toEqual(history);
      expect((await pool.query('SELECT * FROM ballots')).rows).toEqual(ballots);
      expect((await pool.query(`SELECT enum_range(NULL::seat_rank)::text AS ranks`)).rows[0].ranks).toBe('{STANDARD,NGO,OBSERVER}');
      await expect(pool.query("UPDATE committee_seats SET rank='VETO'")).rejects.toMatchObject({code: '22P02'});
      await expect(pool.query('UPDATE committee_seats SET can_vote=false')).rejects.toMatchObject({code: '23514'});
    } finally {await pool.end();}
  });

  it('refuses old committee data without partially applying the content migration', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations'); const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0056-'));
    temporaryDirectories.push(staged);
    const files = (await readdir(source)).filter(file => file.endsWith('.sql')).sort();
    const owner = randomUUID(), committee = randomUUID(), pkg = randomUUID(), version = randomUUID();
    try {
      for (const file of files.filter(file => Number(file.slice(0, 4)) <= 55)) await cp(join(source, file), join(staged, file));
      await runMigrations(pool, staged);
      await pool.query(`INSERT INTO users (id,email,display_name,status,is_system_admin,must_change_password)
        VALUES ($1,'content-migration@example.test','Migration','ACTIVE',false,false)`, [owner]);
      await pool.query(`INSERT INTO rule_packages (id,scope,stable_key) VALUES ($1,'BUILTIN','test:0056')`, [pkg]);
      await pool.query(`INSERT INTO rule_package_versions (id,package_id,version,status,definition,schema_version,published_at)
        VALUES ($1,$2,1,'PUBLISHED','{}',1,now())`, [version, pkg]);
      await pool.query(`INSERT INTO committees (id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id)
        VALUES ($1,$2,'Old names','PRIVATE','CHAIR_OPERATED',$3)`, [committee, owner, version]);
      const file = files.find(file => file.startsWith('0056_'))!;
      await cp(join(source, file), join(staged, file));
      await expect(runMigrations(pool, staged)).rejects.toThrow('COMMITTEE_CONTENT_REBUILD_REQUIRED');
      expect((await pool.query('SELECT name FROM committees WHERE id=$1', [committee])).rows).toEqual([{name: 'Old names'}]);
      expect((await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_name='committees' AND column_name='committee_language'`)).rowCount).toBe(0);
      expect((await pool.query('SELECT schema_compatibility FROM quorum_meta.runtime_metadata')).rows[0].schema_compatibility).toBe(55);
      const rebuilt = spawnSync(process.execPath, ['server/scripts/localization-rebuild.mjs', '--local-development-rebuild'], {
        env: {...process.env, DATABASE_URL: databaseUrl}, encoding: 'utf8'});
      expect(rebuilt.stderr).toBe('');
      expect(rebuilt.status).toBe(0);
      expect(JSON.parse(rebuilt.stdout)).toEqual({removedCommittees: 1, retainedAccountsTemplatesAndSettings: true});
      expect((await pool.query('SELECT id FROM users')).rows).toEqual([{id: owner}]);
      expect((await pool.query('SELECT id FROM rule_package_versions')).rows).toEqual([{id: version}]);
      await runMigrations(pool, source);
      expect((await pool.query('SELECT count(*)::int AS count FROM committees')).rows[0].count).toBe(0);
    } finally {await pool.end();}
  });

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

      expect(first).toEqual(expect.objectContaining({ready: true, latestAppliedVersion: 68}));
      expect(second).toEqual(expect.objectContaining({ready: true, pendingVersions: []}));
      expect(status.ready).toBe(true);
      expect(runtime.rows[0]?.schema_compatibility).toBe(68);
      expect(applied.rowCount).toBe(68);
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
      const cacheTables = await pool.query<{name: string}>(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public' AND table_name='storage_cache_entries'`);
      expect(cacheTables.rowCount).toBe(1);
      await expect(pool.query(`UPDATE system_settings SET pending_review_committee_max_bytes=6000000000
        WHERE singleton=true`)).rejects.toMatchObject({code: '23514'});
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
