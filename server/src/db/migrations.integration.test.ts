// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cp, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadMigrations, migrationStatus, runMigrations} from './migrations';
import {Stage3Service} from '../modules/stage3/service';
import {Stage4Service} from '../modules/stage4/service';
import {Stage5Service} from '../modules/stage5/service';
import {Stage8ArchiveService} from '../modules/operations/archive-service';
import {Stage8DeletionService} from '../modules/operations/deletion-service';
import type {AuthenticatedSession} from '../modules/identity/store';

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
  it('upgrades the remote conflict schema through Chair migration and replica integrity without rewriting history', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0087-')); temporaryDirectories.push(staged);
    try {
      for (const file of await readdir(source)) {
        if (Number(file.slice(0, 4)) <= 87) await cp(join(source, file), join(staged, file));
      }
      await runMigrations(pool, staged);
      const history = (await pool.query('SELECT * FROM quorum_meta.schema_migrations ORDER BY version')).rows;
      expect(history.at(-1)).toMatchObject({version: 87, name: 'chair_conflict_replacements'});
      expect(await runMigrations(pool, source)).toMatchObject({ready: true, latestAppliedVersion: 90});
      expect((await pool.query('SELECT * FROM quorum_meta.schema_migrations WHERE version<=87 ORDER BY version')).rows).toEqual(history);
      expect((await pool.query('SELECT schema_compatibility FROM quorum_meta.runtime_metadata')).rows[0].schema_compatibility).toBe(90);
      expect((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='file_versions'
        AND column_name='resolution_conflict_id'`)).rowCount).toBe(1);
      expect((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='storage_agent_tasks'
        AND column_name='migration_item_id'`)).rowCount).toBe(1);
      expect(await runMigrations(pool, source)).toMatchObject({ready: true, pendingVersions: []});
    } finally {await pool.end();}
  });

  it('upgrades older Beijing committees and unfinished sessions while preserving users and frozen proceedings', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0084-')); temporaryDirectories.push(staged);
    const owner = randomUUID(), administrator = randomUUID(), packageId = randomUUID(), countryTemplate = randomUUID(), template = randomUUID();
    const oldDefinition = JSON.parse(await readFile('packages/rule-schema/fixtures/beijing-academic.v1.json', 'utf8'));
    oldDefinition.ballots.chairMayCorrectVote = false;
    oldDefinition.speakerLists[0].yieldTypes = ['CHAIR'];
    oldDefinition.metadata.names.en = 'Historical Beijing Rules';
    const committees: Array<{id: string; versionId: string; sessions: Array<{id: string; status: string}>}> = [];
    try {
      for (const file of (await readdir(source)).filter(file => file.endsWith('.sql') && Number(file.slice(0, 4)) < 84))
        await cp(join(source, file), join(staged, file));
      await runMigrations(pool, staged);
      // Compare the frozen migration definition with ordinary built-in installation.
      await new Stage3Service(pool).ensureBuiltins();
      const expectedDefinition = (await pool.query('SELECT definition FROM rule_package_versions WHERE version=12')).rows[0].definition;
      await pool.query("UPDATE rule_packages SET stable_key='builtin:startup-reference'");
      for (const [id, admin] of [[owner, false], [administrator, true]]) await pool.query(`INSERT INTO users
        (id,email,display_name,status,is_system_admin,must_change_password) VALUES($1,$2,'Rule user','ACTIVE',$3,false)`,
      [id, `${id}@example.test`, admin]);
      await pool.query("UPDATE system_settings SET default_committee_creator_is_chair=false");
      await pool.query(`INSERT INTO country_templates(id,owner_user_id,names,default_language,country_languages)
        VALUES($1,$2,'{"en":"Countries"}','en',ARRAY['en'])`, [countryTemplate, owner]);
      await pool.query(`INSERT INTO country_template_countries
        (id,country_template_id,stable_key,names,default_language,flag_type,flag_value)
        VALUES($1,$2,'china','{"en":"China"}','en','STANDARD','cn')`, [randomUUID(), countryTemplate]);
      await pool.query(`INSERT INTO committee_templates(id,owner_user_id,names,default_language,country_template_key)
        VALUES($1,$2,'{"en":"Committee template"}','en','builtin:default')`, [template, owner]);
      await pool.query(`INSERT INTO committee_template_members
        (id,committee_template_id,stable_key,names,default_language,rank,can_vote,has_veto,must_vote,flag_type,flag_value)
        VALUES($1,$2,'china','{"en":"China"}','en','STANDARD',true,false,false,'STANDARD','cn')`, [randomUUID(), template]);
      await pool.query("INSERT INTO rule_packages(id,scope,stable_key) VALUES($1,'BUILTIN','builtin:beijing-academic')", [packageId]);
      for (const [index, version] of [1, 6, 10, 11].entries()) {
        const versionId = randomUUID(), committeeId = randomUUID(), seatId = randomUUID();
        await pool.query(`INSERT INTO rule_package_versions(id,package_id,version,status,definition,schema_version,published_at)
          VALUES($1,$2,$3,'PUBLISHED',$4,1,now())`, [versionId, packageId, version, oldDefinition]);
        await pool.query(`INSERT INTO committees(id,owner_user_id,name,visibility,operation_mode,status,
          active_rule_package_version_id,content_snapshot,committee_language)
          VALUES($1,$2,$3,'PRIVATE','CHAIR_OPERATED',$4,$5,$6,'en')`,
        [committeeId, owner, `Beijing v${version}`, index % 2 ? 'PAUSED' : 'ACTIVE', versionId,
          {schemaVersion: 1, countryTemplate: {countries: [{stableKey: 'china', names: {en: 'China'}, flag: {type: 'STANDARD', value: 'cn'}}]},
            committeeTemplate: null, initialRulePackageVersionId: versionId}]);
        await pool.query(`INSERT INTO committee_seats(id,committee_id,stable_key,display_name,rank,flag_type,flag_value)
          VALUES($1,$2,'china','China','STANDARD','STANDARD','cn')`, [seatId, committeeId]);
        await pool.query(`INSERT INTO committee_notes(id,committee_id,title,content,created_by_user_id)
          VALUES($1,$2,'Notes','Keep these notes',$3)`, [randomUUID(), committeeId, owner]);
        await pool.query(`INSERT INTO committee_rule_bindings
          (id,committee_id,package_version_id,effective_from_event_sequence,activated_by_user_id)
          VALUES($1,$2,$3,1,$4)`, [randomUUID(), committeeId, versionId, owner]);
        const sessions = [];
        for (const status of ['OPEN', 'PENDING', 'CLOSED']) {
          const id = randomUUID(); sessions.push({id, status});
          await pool.query(`INSERT INTO meeting_sessions(id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id,status,closed_at)
            VALUES($1,$2,'formal-debate',$3,$4,$5::meeting_session_status,
              CASE WHEN $5::meeting_session_status='CLOSED' THEN now() END)`, [id, committeeId, versionId, owner, status]);
        }
        committees.push({id: committeeId, versionId, sessions});
        const sessionId = sessions[0].id, motionId = randomUUID(), ballotId = randomUUID();
        const rollCallId = randomUUID();
        await pool.query(`INSERT INTO roll_calls(id,committee_id,meeting_session_id,current_seat_id,rule_package_version_id,allowed_responses,started_by_user_id)
          VALUES($1,$2,$3,$4,$5,ARRAY['PRESENT','ABSENT'],$6)`, [rollCallId, committeeId, sessionId, seatId, versionId, owner]);
        await pool.query(`INSERT INTO roll_call_entries(id,committee_id,roll_call_id,seat_id,seat_display_name,response,actor_user_id,on_behalf_of_seat_id,rule_package_version_id)
          VALUES($1,$2,$3,$4,'China','PRESENT',$5,$4,$6)`, [randomUUID(), committeeId, rollCallId, seatId, owner, versionId]);
        await pool.query(`INSERT INTO points(id,committee_id,meeting_session_id,point_type_id,content,raised_by_seat_id,
          raised_by_seat_display_name,actor_user_id,on_behalf_of_seat_id,rule_package_version_id,interrupt_requested)
          VALUES($1,$2,$3,$4,'Historical point',$5,'China',$6,$5,$7,false)`,
        [randomUUID(), committeeId, sessionId, oldDefinition.points[0].id, seatId, owner, versionId]);
        await pool.query(`INSERT INTO motions(id,committee_id,meeting_session_id,motion_type_id,proposed_by_seat_id,
          proposed_by_seat_display_name,actor_user_id,on_behalf_of_seat_id,rule_package_version_id,rule_evaluation,required_second_count)
          VALUES($1,$2,$3,'open-unmoderated-caucus',$4,'China',$5,$4,$6,'{"resolvedValues":{"procedural":true},"definition":{},"facts":{}}',0)`, [motionId, committeeId, sessionId, seatId, owner, versionId]);
        await pool.query(`INSERT INTO ballots(id,committee_id,meeting_session_id,subject_type,subject_id,procedural,choices,
          rule_package_version_id,rule_evaluation,eligibility_snapshot,threshold_definition,threshold_value,opened_by_user_id)
          VALUES($1,$2,$3,'MOTION',$4,true,ARRAY['FOR','AGAINST']::ballot_choice[],$5,'{}','[]','{}',1,$6)`,
        [ballotId, committeeId, sessionId, motionId, versionId, owner]);
        await pool.query(`INSERT INTO ballot_votes(id,ballot_id,seat_id,seat_display_name,current_choice,cast_by_user_id,cast_on_behalf)
          VALUES($1,$2,$3,'China','FOR',$4,true)`, [randomUUID(), ballotId, seatId, owner]);
        const documentId = randomUUID(), documentVersionId = randomUUID();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO documents(id,committee_id,meeting_session_id,kind,rule_package_version_id,created_by_user_id,current_version_id)
            VALUES($1,$2,$3,'RESOLUTION',$4,$5,$6)`, [documentId, committeeId, sessionId, versionId, owner, documentVersionId]);
          await client.query(`INSERT INTO document_versions(id,document_id,version_number,content,created_by_user_id)
            VALUES($1,$2,1,'Historical draft content',$3)`, [documentVersionId, documentId, owner]);
          await client.query("INSERT INTO document_voting(document_id,direct_vote_majority) VALUES($1,'TWO_THIRDS')", [documentId]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        const speakerListId = randomUUID(), timerId = randomUUID();
        await pool.query(`INSERT INTO timer_states(id,committee_id,owner_type,owner_id,remaining_at_start_ms,created_by_user_id)
          VALUES($1,$2,'SPEAKER_LIST',$3,120000,$4)`, [timerId, committeeId, speakerListId, owner]);
        await pool.query(`INSERT INTO speaker_lists(id,committee_id,meeting_session_id,kind,default_speech_ms,rule_package_version_id,speech_timer_id,created_by_user_id)
          VALUES($1,$2,$3,'GENERAL',120000,$4,$5,$6)`, [speakerListId, committeeId, sessionId, versionId, timerId, owner]);
      }
      const tables = ['users', 'country_templates', 'country_template_countries', 'committee_templates', 'committee_template_members',
        'committee_seats', 'committee_notes', 'committee_rule_bindings', 'roll_calls', 'roll_call_entries', 'points', 'motions', 'ballots', 'ballot_votes',
        'documents', 'document_versions', 'document_voting', 'speaker_lists', 'timer_states'];
      const preserved = async () => {
        const rows = await Promise.all(tables.map(async table => (await pool.query(`SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
        return [...rows, (await pool.query("SELECT to_jsonb(s)-'schema_compatibility' AS settings FROM system_settings s")).rows,
          (await pool.query('SELECT id,content_snapshot FROM committees ORDER BY id')).rows];
      };
      await cp(join(source, '0084_beijing_rule_upgrade.sql'), join(staged, '0084_beijing_rule_upgrade.sql'));
      const before = await preserved();
      await pool.query("ALTER TABLE audit_log ADD CONSTRAINT reject_rule_upgrade CHECK(request_id<>'migration:0084')");
      await expect(runMigrations(pool, staged)).rejects.toThrow('reject_rule_upgrade');
      expect((await migrationStatus(pool, staged)).latestAppliedVersion).toBe(83);
      expect((await pool.query('SELECT id FROM rule_package_versions WHERE package_id=$1 AND version=12', [packageId])).rows).toEqual([]);
      expect((await pool.query('SELECT revision FROM committees')).rows.every(row => row.revision === 1)).toBe(true);
      expect((await pool.query('SELECT revision FROM meeting_sessions')).rows.every(row => row.revision === 1)).toBe(true);
      expect((await pool.query('SELECT sequence FROM committee_events')).rows).toEqual([]);
      expect(await preserved()).toEqual(before);
      await pool.query('ALTER TABLE audit_log DROP CONSTRAINT reject_rule_upgrade');
      await runMigrations(pool, staged);
      const latest = (await pool.query('SELECT id,definition FROM rule_package_versions WHERE package_id=$1 AND version=12', [packageId])).rows[0];
      expect(latest.definition).toEqual(expectedDefinition);
      expect(await preserved()).toEqual(before);
      for (const committee of committees) {
        expect((await pool.query('SELECT active_rule_package_version_id,revision FROM committees WHERE id=$1', [committee.id])).rows[0])
          .toEqual({active_rule_package_version_id: latest.id, revision: 2});
        for (const session of committee.sessions) expect((await pool.query(
          'SELECT active_rule_package_version_id,revision FROM meeting_sessions WHERE id=$1', [session.id])).rows[0])
          .toEqual({active_rule_package_version_id: session.status === 'CLOSED' ? committee.versionId : latest.id,
            revision: session.status === 'CLOSED' ? 1 : 2});
      }
      expect((await pool.query('SELECT definition FROM rule_package_versions WHERE package_id=$1 AND version<12', [packageId])).rows)
        .toEqual([1, 6, 10, 11].map(() => ({definition: oldDefinition})));
      const audits = (await pool.query("SELECT * FROM audit_log WHERE request_id='migration:0084'")).rows;
      expect(audits).toHaveLength(4);
      expect(audits.every(row => row.actor_user_id === null && row.before_summary.meetingSessions.length === 2)).toBe(true);
      expect((await pool.query("SELECT * FROM committee_events WHERE event_type='rule_package.activated'")).rows).toHaveLength(4);
      await expect(pool.query('DELETE FROM rule_package_versions WHERE id=$1', [committees[0].versionId]))
        .rejects.toThrow('published rule versions are immutable');
      // Re-execution and subsequent startup must not append events or bump revisions.
      await pool.query((await loadMigrations(source)).find(migration => migration.version === 84)!.sql);
      await runMigrations(pool, staged); await new Stage3Service(pool).ensureBuiltins();
      expect((await pool.query("SELECT * FROM audit_log WHERE request_id='migration:0084'")).rows).toEqual(audits);
      expect((await pool.query('SELECT revision FROM committees')).rows.every(row => row.revision === 2)).toBe(true);
      // The next release retires old Beijing catalog rows without changing any
      // frozen proceedings or IDs. Unrelated built-in packages remain intact.
      await cp(join(source, '0085_committee_creation_defaults.sql'), join(staged, '0085_committee_creation_defaults.sql'));
      await runMigrations(pool, staged);
      const archived = committees[0];
      await pool.query("UPDATE committees SET status='ARCHIVED',active_rule_package_version_id=$2 WHERE id=$1", [archived.id, archived.versionId]);
      await pool.query(`UPDATE system_settings SET committee_creation_defaults=jsonb_set(committee_creation_defaults,
        '{defaultRulePackageVersionId}',to_jsonb($1::text))`, [archived.versionId]);
      const frozen = await preserved();
      const allVersions = (await pool.query('SELECT * FROM rule_package_versions ORDER BY id')).rows;
      await cp(join(source, '0086_rule_version_snapshots.sql'), join(staged, '0086_rule_version_snapshots.sql'));
      await pool.query("ALTER TABLE audit_log ADD CONSTRAINT reject_snapshots CHECK(request_id<>'migration:0086')");
      await expect(runMigrations(pool, staged)).rejects.toThrow('reject_snapshots');
      expect((await migrationStatus(pool, staged)).latestAppliedVersion).toBe(85);
      expect((await pool.query("SELECT to_regclass('rule_version_snapshots') AS relation")).rows[0].relation).toBeNull();
      expect((await pool.query('SELECT * FROM rule_package_versions ORDER BY id')).rows).toEqual(allVersions);
      expect(await preserved()).toEqual(frozen);
      await pool.query('ALTER TABLE audit_log DROP CONSTRAINT reject_snapshots');
      await runMigrations(pool, staged);
      expect((await pool.query('SELECT * FROM rule_version_snapshots ORDER BY id')).rows).toEqual(allVersions);
      expect((await pool.query('SELECT * FROM rule_package_versions WHERE package_id<>$1 ORDER BY id', [packageId])).rows)
        .toEqual(allVersions.filter(row => row.package_id !== packageId));
      expect((await pool.query('SELECT id FROM rule_package_versions WHERE package_id=$1', [packageId])).rows).toEqual([{id: latest.id}]);
      expect((await pool.query("SELECT 1 FROM pg_constraint WHERE contype='f' AND confrelid='rule_package_versions'::regclass")).rows).toEqual([]);
      expect((await pool.query('SELECT committee_creation_defaults FROM system_settings')).rows[0].committee_creation_defaults.defaultRulePackageVersionId).toBe(latest.id);
      // Everything but the intentionally migrated system default is unchanged.
      const after = await preserved(); expect(after.slice(0, tables.length)).toEqual(frozen.slice(0, tables.length));
      expect(after.at(-1)).toEqual(frozen.at(-1));
      const auth = {sessionId: randomUUID(), user: {id: owner, isSystemAdmin: false, mustChangePassword: false}} as AuthenticatedSession;
      const stage3 = new Stage3Service(pool), stage4 = new Stage4Service(pool), stage5 = new Stage5Service(pool);
      const context = {requestId: 'snapshot-history', sourceIp: '127.0.0.1', userAgent: 'Vitest'};
      expect(await stage3.validateRuleVersion(auth, archived.versionId)).toEqual({valid: true, issues: []});
      for (const item of committees) {
        const snapshot = await stage4.snapshot(item.id, auth);
        expect(snapshot.activeRules.versionId).toBe(item.id === archived.id ? archived.versionId : latest.id);
        expect(snapshot.activeRules.names).toEqual(item.id === archived.id ? oldDefinition.metadata.names : latest.definition.metadata.names);
        expect(snapshot.rollCall?.rulePackageVersionId).toBe(item.versionId);
        expect(snapshot.points[0].typeNames).toEqual(oldDefinition.points[0].names);
        expect(snapshot.speakerLists?.[0].yieldTypes).toEqual(oldDefinition.speakerLists[0].yieldTypes);
        expect(snapshot.ballots?.[0]).toMatchObject({rulePackageVersionId: item.versionId, chairMayCorrectVote: false});
        expect(snapshot.documents?.[0].rulePackageVersionId).toBe(item.versionId);
      }
      const exported = await new Stage8ArchiveService(pool).exportCommittee(auth, archived.id);
      let archiveText = ''; for await (const chunk of exported.content) archiveText += chunk.toString();
      const records = archiveText.trim().split('\n').map(line => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({section: 'rule_versions', record: expect.objectContaining({id: archived.versionId, definition: oldDefinition})}));
      await expect(pool.query('UPDATE rule_version_snapshots SET definition=definition WHERE id=$1', [archived.versionId])).rejects.toThrow('rule snapshots are immutable');
      await expect(pool.query('DELETE FROM rule_version_snapshots WHERE id=$1', [archived.versionId])).rejects.toThrow('rule snapshots are immutable');
      await pool.query("INSERT INTO committee_capabilities(committee_id,user_id,capability,granted_by_user_id) VALUES($1,$2,'CHAIR',$2)", [committees[1].id, owner]);
      await expect(stage3.activateRules(auth, committees[1].id, archived.versionId, 2, context)).rejects.toMatchObject({reason: 'RULE_VERSION_NOT_PUBLISHED'});
      const snapshotAudits = (await pool.query("SELECT * FROM audit_log WHERE request_id='migration:0086' ORDER BY id")).rows;
      await runMigrations(pool, staged); await stage3.ensureBuiltins();
      expect((await pool.query("SELECT * FROM audit_log WHERE request_id='migration:0086' ORDER BY id")).rows).toEqual(snapshotAudits);
      expect((await pool.query('SELECT * FROM rule_version_snapshots ORDER BY id')).rows).toEqual(allVersions);
      // A normal command still reads a retired rule's original speaker settings.
      const active = committees[2];
      await pool.query("INSERT INTO committee_capabilities(committee_id,user_id,capability,granted_by_user_id) VALUES($1,$2,'CHAIR',$2)", [active.id, owner]);
      const list = (await stage4.snapshot(active.id, auth)).speakerLists![0];
      expect((await stage5.updateSpeakerList(auth, list.id, {baseRevision: list.revision, defaultSpeechMs: 75000}, context)).yieldTypes)
        .toEqual(oldDefinition.speakerLists[0].yieldTypes);
      const override = await stage3.overrideRule(auth, active.id, {scope: 'FUTURE', path: 'ballots.chairMayCorrectVote', value: false}, context);
      expect((await pool.query('SELECT id FROM rule_version_snapshots WHERE id=$1', [override.createdVersionId])).rowCount).toBe(1);
      let revision = (await stage4.snapshot(active.id, auth)).committee.revision;
      await stage3.activateRules(auth, active.id, override.createdVersionId!, revision, context);
      await pool.query("UPDATE committees SET visibility='PUBLIC' WHERE id=$1", [active.id]);
      expect((await stage4.snapshot(active.id)).activeRules.names).toBeUndefined();
      expect((await stage4.snapshot(active.id, auth)).activeRules.names).toEqual(expectedDefinition.metadata.names);
      revision = (await stage4.snapshot(active.id, auth)).committee.revision;
      await stage3.archiveCommittee(auth, active.id, revision, context);
      const deletion = new Stage8DeletionService(pool);
      await deletion.requestDeletion(auth, active.id, {baseRevision: revision+1, confirmationName: 'Beijing v10'}, randomUUID(), context);
      expect((await deletion.processNext())?.status).toBe('COMPLETED');
      expect((await pool.query('SELECT id FROM rule_version_snapshots WHERE id=$1', [override.createdVersionId])).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM rule_version_snapshots WHERE id=$1', [archived.versionId])).rowCount).toBe(1);
    } finally { await pool.end(); }
  });

  it('repairs stale unfinished sessions on v12 committees without downgrading newer or changing custom and archived committees', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0084-sessions-')); temporaryDirectories.push(staged);
    const owner = randomUUID(), oldId = randomUUID(), futureId = randomUUID(), customPackage = randomUUID(), customId = randomUUID();
    try {
      for (const file of (await readdir(source)).filter(file => file.endsWith('.sql') && Number(file.slice(0, 4)) < 84))
        await cp(join(source, file), join(staged, file));
      await runMigrations(pool, staged); await new Stage3Service(pool).ensureBuiltins();
      const latest = (await pool.query('SELECT id,package_id,definition FROM rule_package_versions WHERE version=12')).rows[0];
      await pool.query(`INSERT INTO users(id,email,display_name,status,is_system_admin,must_change_password)
        VALUES($1,'session-rules@example.test','Owner','ACTIVE',false,false)`, [owner]);
      for (const [id, version] of [[oldId, 6], [futureId, 13]]) await pool.query(`INSERT INTO rule_package_versions
        (id,package_id,version,status,definition,schema_version,published_at) VALUES($1,$2,$3,'PUBLISHED',$4,1,now())`,
      [id, latest.package_id, version, latest.definition]);
      await pool.query("INSERT INTO rule_packages(id,scope,owner_user_id,stable_key) VALUES($1,'SYSTEM',$2,'system:custom')", [customPackage, owner]);
      await pool.query(`INSERT INTO rule_package_versions(id,package_id,version,status,definition,schema_version,published_at)
        VALUES($1,$2,1,'PUBLISHED',$3,1,now())`, [customId, customPackage, latest.definition]);
      const cases = [
        {name: 'stale-sessions', version: latest.id, status: 'ACTIVE', sessionVersion: oldId, changed: true},
        {name: 'paused-stale-sessions', version: latest.id, status: 'PAUSED', sessionVersion: oldId, changed: true},
        {name: 'healthy', version: latest.id, status: 'ACTIVE', sessionVersion: latest.id, changed: false},
        {name: 'custom', version: customId, status: 'ACTIVE', sessionVersion: oldId, changed: false},
        {name: 'archived', version: oldId, status: 'ARCHIVED', sessionVersion: oldId, changed: false},
        {name: 'deleting', version: oldId, status: 'DELETING', sessionVersion: oldId, changed: false},
        {name: 'future', version: futureId, status: 'ACTIVE', sessionVersion: oldId, changed: false}
      ];
      const committees = [];
      for (const item of cases) {
        const id = randomUUID(); const sessions = [];
        await pool.query(`INSERT INTO committees(id,owner_user_id,name,visibility,operation_mode,status,
          active_rule_package_version_id,content_snapshot,committee_language) VALUES($1,$2,$3,'PRIVATE','CHAIR_OPERATED',$4,$5,$6,'en')`,
        [id, owner, item.name, item.status, item.version,
          {schemaVersion: 1, countryTemplate: {countries: []}, committeeTemplate: null, initialRulePackageVersionId: item.version}]);
        for (const status of ['OPEN', 'PENDING', 'CLOSED']) {
          const sessionId = randomUUID(); sessions.push({id: sessionId, status});
          await pool.query(`INSERT INTO meeting_sessions(id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id,status,closed_at)
            VALUES($1,$2,'formal-debate',$3,$4,$5::meeting_session_status,
              CASE WHEN $5::meeting_session_status='CLOSED' THEN now() END)`, [sessionId, id, item.sessionVersion, owner, status]);
        }
        committees.push({...item, id, sessions});
      }
      await cp(join(source, '0084_beijing_rule_upgrade.sql'), join(staged, '0084_beijing_rule_upgrade.sql'));
      const beforeVersions = (await pool.query('SELECT * FROM rule_package_versions ORDER BY id')).rows;
      await runMigrations(pool, staged);
      expect((await pool.query('SELECT * FROM rule_package_versions ORDER BY id')).rows).toEqual(beforeVersions);
      for (const committee of committees) {
        expect((await pool.query('SELECT active_rule_package_version_id,revision FROM committees WHERE id=$1', [committee.id])).rows[0])
          .toEqual({active_rule_package_version_id: committee.version, revision: committee.changed ? 2 : 1});
        for (const session of committee.sessions) {
          const changed = committee.changed && session.status !== 'CLOSED';
          expect((await pool.query('SELECT active_rule_package_version_id,revision FROM meeting_sessions WHERE id=$1', [session.id])).rows[0])
            .toEqual({active_rule_package_version_id: changed ? latest.id : committee.sessionVersion, revision: changed ? 2 : 1});
        }
      }
      const audits = (await pool.query("SELECT before_summary,after_summary FROM audit_log WHERE request_id='migration:0084'")).rows;
      expect(audits).toHaveLength(2);
      expect(audits.every(row => row.before_summary.versionId === latest.id && row.before_summary.meetingSessions.length === 2
        && row.before_summary.meetingSessions.every((session: {versionId: string}) => session.versionId === oldId)
        && row.after_summary.versionId === latest.id)).toBe(true);
      await pool.query((await loadMigrations(source)).find(migration => migration.version === 84)!.sql);
      await runMigrations(pool, staged); await new Stage3Service(pool).ensureBuiltins();
      expect((await pool.query("SELECT before_summary,after_summary FROM audit_log WHERE request_id='migration:0084'")).rows).toEqual(audits);
      expect((await pool.query('SELECT * FROM rule_package_versions ORDER BY id')).rows).toEqual(beforeVersions);
      await cp(join(source, '0085_committee_creation_defaults.sql'), join(staged, '0085_committee_creation_defaults.sql'));
      await cp(join(source, '0086_rule_version_snapshots.sql'), join(staged, '0086_rule_version_snapshots.sql'));
      await runMigrations(pool, staged);
      expect((await pool.query('SELECT * FROM rule_version_snapshots ORDER BY id')).rows).toEqual(beforeVersions);
      expect((await pool.query('SELECT id FROM rule_package_versions WHERE package_id=$1', [latest.package_id])).rows).toEqual([{id: futureId}]);
      expect((await pool.query('SELECT * FROM rule_package_versions WHERE package_id=$1', [customPackage])).rows)
        .toEqual(beforeVersions.filter(row => row.package_id === customPackage));
      expect((await pool.query("SELECT active_rule_package_version_id FROM committees WHERE status IN ('ARCHIVED','DELETING')")).rows)
        .toEqual([{active_rule_package_version_id: oldId}, {active_rule_package_version_id: oldId}]);
      await runMigrations(pool, staged); await new Stage3Service(pool).ensureBuiltins();
      expect((await pool.query('SELECT id FROM rule_package_versions WHERE package_id=$1', [latest.package_id])).rows).toEqual([{id: futureId}]);
    } finally { await pool.end(); }
  });

  it('enables motion display for existing committees and upgrades only current rule references', async () => {
    const pool = new Pool({connectionString: databaseUrl});
    const source = resolve('server/migrations');
    const staged = await mkdtemp(join(tmpdir(), 'quorum-migrations-0080-')); temporaryDirectories.push(staged);
    const owner = randomUUID(), packageId = randomUUID(), versionId = randomUUID(), committeeId = randomUUID();
    const closed = randomUUID(), open = randomUUID();
    const definition = {motions: [{id: 'open-debate'}, {id: 'suspend-debate'}, {id: 'resume-debate'}, {id: 'close-debate'}]};
    try {
      for (const file of (await readdir(source)).filter(file => file.endsWith('.sql') && Number(file.slice(0, 4)) < 80))
        await cp(join(source, file), join(staged, file));
      await runMigrations(pool, staged);
      await pool.query(`INSERT INTO users(id,email,display_name,status,is_system_admin,must_change_password)
        VALUES($1,'motions@example.test','Owner','ACTIVE',false,false)`, [owner]);
      await pool.query("INSERT INTO rule_packages(id,scope,stable_key) VALUES($1,'BUILTIN','builtin:beijing-academic')", [packageId]);
      await pool.query(`INSERT INTO rule_package_versions(id,package_id,version,status,definition,schema_version,published_at)
        VALUES($1,$2,11,'PUBLISHED',$3,1,now())`, [versionId, packageId, definition]);
      await pool.query(`INSERT INTO committees(id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id,
        content_snapshot,committee_language) VALUES($1,$2,'Motions','PUBLIC','CHAIR_OPERATED',$3,$4,'en')`,
      [committeeId, owner, versionId, {schemaVersion: 1, countryTemplate: {countries: []}, committeeTemplate: null,
        initialRulePackageVersionId: versionId}]);
      for (const [id, status] of [[closed, 'CLOSED'], [open, 'OPEN']]) await pool.query(`INSERT INTO meeting_sessions
        (id,committee_id,phase_id,active_rule_package_version_id,created_by_user_id,status,closed_at)
        VALUES($1,$2,'formal-debate',$3,$4,$5::meeting_session_status,
          CASE WHEN $5::meeting_session_status='CLOSED' THEN now() END)`, [id, committeeId, versionId, owner, status]);
      await runMigrations(pool, source);
      await runMigrations(pool, source);
      const versions = (await pool.query('SELECT id,version,definition FROM rule_version_snapshots ORDER BY version')).rows;
      expect((await pool.query('SELECT version FROM rule_package_versions')).rows).toEqual([{version: 12}]);
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({id: versionId, version: 11, definition});
      expect(versions[1].definition.motions).toEqual([{id: 'open-debate'}, {id: 'close-debate'}]);
      const committee = (await pool.query('SELECT * FROM committees WHERE id=$1', [committeeId])).rows[0];
      expect(committee).toMatchObject({show_motions_on_demand: true, group_motion_types: true, active_rule_package_version_id: versions[1].id, revision: 2});
      expect(committee.content_snapshot.initialRulePackageVersionId).toBe(versionId);
      const sessions = (await pool.query('SELECT id,active_rule_package_version_id FROM meeting_sessions')).rows;
      expect(sessions).toContainEqual({id: closed, active_rule_package_version_id: versionId});
      expect(sessions).toContainEqual({id: open, active_rule_package_version_id: versions[1].id});
      const audits = (await pool.query("SELECT actor_user_id,after_summary FROM audit_log WHERE request_id='migration:0080'")).rows;
      expect(audits).toEqual([{actor_user_id: null, after_summary: {versionId: versions[1].id, revision: 2}}]);
      const events = await pool.query("SELECT 1 FROM committee_events WHERE event_type='rule_package.activated'");
      expect(events.rowCount).toBe(1);
    } finally { await pool.end(); }
  });

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
    const available = await loadMigrations(migrationsDirectory);
    const latestVersion = available.at(-1)!.version;
    try {
      const first = await runMigrations(pool, migrationsDirectory);
      const second = await runMigrations(pool, migrationsDirectory);
      const status = await migrationStatus(pool, migrationsDirectory);
      const runtime = await pool.query<{schema_compatibility: number}>(
        'SELECT schema_compatibility FROM quorum_meta.runtime_metadata WHERE singleton = true'
      );
      const applied = await pool.query('SELECT version FROM quorum_meta.schema_migrations');

      expect(first).toEqual(expect.objectContaining({ready: true, latestAppliedVersion: latestVersion}));
      expect(second).toEqual(expect.objectContaining({ready: true, pendingVersions: []}));
      expect(status.ready).toBe(true);
      expect(runtime.rows[0]?.schema_compatibility).toBe(latestVersion);
      expect(applied.rowCount).toBe(available.length);
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
