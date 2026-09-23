// One-time, explicitly destructive LOCAL DEVELOPMENT cutover from schema 55.
// Run with app/workers stopped. Accounts, source templates and global rules remain.
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

if (!process.argv.includes('--local-development-rebuild')) {
  throw new Error('Requires --local-development-rebuild; this removes every committee and its business records.');
}
const {loadConfig} = await import(pathToFileURL(resolve('server/dist/config.js')).href);
const {COMMITTEE_PURGE_QUERIES} = await import(pathToFileURL(resolve('server/dist/modules/operations/deletion-service.js')).href);
const pool = new pg.Pool({connectionString: loadConfig().databaseUrl});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query('LOCK TABLE committees IN ACCESS EXCLUSIVE MODE');
  const version = (await client.query('SELECT max(version)::int AS version FROM quorum_meta.schema_migrations')).rows[0].version;
  if (version !== 55) throw new Error(`Expected schema 55, found ${version}`);
  // Schema 55 already contains these history tables but lacks their controlled-purge exception.
  const purgeMigration = await readFile('server/migrations/0063_complete_proceedings_purge.sql', 'utf8');
  await client.query(purgeMigration.split('-- SCHEMA_VERSION')[0]);
  const preserved = async () => (await client.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t) AS users,
    (SELECT to_jsonb(t) FROM system_settings t) AS settings,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM country_templates t) AS countries,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM committee_templates t) AS templates,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM country_template_countries t) AS countryMembers,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM committee_template_members t) AS committeeMembers,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM rule_packages t WHERE committee_id IS NULL) AS rules,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM rule_package_versions v JOIN rule_packages p
      ON p.id=v.package_id WHERE p.committee_id IS NULL) AS versions`)).rows[0];
  const before = JSON.stringify(await preserved());
  const committees = (await client.query('SELECT id,name,owner_user_id FROM committees ORDER BY id')).rows;
  for (const committee of committees) {
    const token = randomUUID();
    await client.query(`INSERT INTO committee_deletion_jobs
      (id,committee_id,requested_by_user_id,confirmation_name_sha256,status,claimed_at,claim_token)
      VALUES ($1,$2,$3,$4,'IN_PROGRESS',now(),$5)
      ON CONFLICT (committee_id) DO UPDATE SET status='IN_PROGRESS',claimed_at=now(),claim_token=$5,completed_at=NULL`,
      [randomUUID(),committee.id,committee.owner_user_id,createHash('sha256').update(committee.name).digest(),token]);
    await client.query(`SELECT set_config('quorum.committee_purge_id',$1,true),
      set_config('quorum.committee_purge_token',$2,true)`, [committee.id,token]);
    // This script is guarded to schema 55; resolution countries were introduced in schema 67.
    for (const query of COMMITTEE_PURGE_QUERIES) {
      if (query.startsWith('DELETE FROM resolution_countries ')) continue;
      await client.query(query,[committee.id]);
    }
    await client.query(`UPDATE committee_deletion_jobs SET status='COMPLETED',completed_at=now(),
      claimed_at=NULL,claim_token=NULL,failure_code=NULL,failure_reason=NULL WHERE committee_id=$1`,[committee.id]);
  }
  if (before !== JSON.stringify(await preserved())) throw new Error('Retained account, template or system data changed; rolling back.');
  await client.query('COMMIT');
  console.log(JSON.stringify({removedCommittees: committees.length, retainedAccountsTemplatesAndSettings: true}));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {client.release(); await pool.end();}
