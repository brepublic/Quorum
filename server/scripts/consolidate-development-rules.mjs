// Explicitly destructive local-development cleanup; never run by startup/migrations.
// Stop app/workers, then run from the repository/app root with the flag below.
import {createHash, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

if (!process.argv.includes('--local-development-rebuild')) throw new Error('Requires --local-development-rebuild.');
const {loadConfig} = await import(pathToFileURL(resolve('server/dist/config.js')).href);
const {COMMITTEE_PURGE_QUERIES} = await import(pathToFileURL(resolve('server/dist/modules/operations/deletion-service.js')).href);
const pool = new pg.Pool({connectionString: loadConfig().databaseUrl});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query('LOCK TABLE committees, rule_packages, rule_package_versions IN ACCESS EXCLUSIVE MODE');
  const keep = (await client.query(`SELECT v.id,v.package_id FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
    WHERE p.scope='BUILTIN' AND p.stable_key='builtin:beijing-academic' AND v.version=5 AND v.status='PUBLISHED'`)).rows;
  if (keep.length !== 1) throw new Error('Expected exactly one published Beijing version 5.');
  const retained = keep[0];
  const committees = (await client.query(`SELECT id,name,owner_user_id FROM committees
    WHERE active_rule_package_version_id IS DISTINCT FROM $1 ORDER BY id`, [retained.id])).rows;
  const preserved = async () => JSON.stringify((await client.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t) AS users,
    (SELECT to_jsonb(t) FROM system_settings t) AS settings,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM country_templates t) AS countries,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM committee_templates t) AS templates,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM country_template_countries t) AS countryMembers,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM committee_template_members t) AS committeeMembers`)).rows[0]);
  const before = await preserved();
  // Only this immutable-rule trigger is relaxed in this explicit transaction.
  await client.query('ALTER TABLE rule_package_versions DISABLE TRIGGER rule_package_versions_published_immutable');
  for (const committee of committees) {
    const token = randomUUID();
    await client.query(`INSERT INTO committee_deletion_jobs
      (id,committee_id,requested_by_user_id,confirmation_name_sha256,status,claimed_at,claim_token)
      VALUES ($1,$2,$3,$4,'IN_PROGRESS',now(),$5)
      ON CONFLICT (committee_id) DO UPDATE SET status='IN_PROGRESS',claimed_at=now(),claim_token=$5,completed_at=NULL`,
    [randomUUID(),committee.id,committee.owner_user_id,createHash('sha256').update(committee.name).digest(),token]);
    await client.query(`SELECT set_config('quorum.committee_purge_id',$1,true),set_config('quorum.committee_purge_token',$2,true)`,[committee.id,token]);
    // Normal deletion drains caches and portal sessions before its final purge.
    // This explicitly disposable development reset removes those records directly.
    for (const query of [
      `DELETE FROM storage_cache_entries WHERE committee_id=$1`,
      `DELETE FROM delegate_file_metadata WHERE file_entry_id IN (SELECT id FROM file_entries WHERE committee_id=$1)`,
      `DELETE FROM delegate_file_upload_contexts WHERE upload_id IN (SELECT id FROM file_uploads WHERE committee_id=$1)`,
      `DELETE FROM delegate_file_sessions WHERE share_id IN (SELECT id FROM delegate_file_shares WHERE committee_id=$1)`,
      `DELETE FROM delegate_file_shares WHERE committee_id=$1`
    ]) await client.query(query,[committee.id]);
    const queries = [...COMMITTEE_PURGE_QUERIES];
    const firstFile = queries.findIndex(query => query.startsWith('DELETE FROM file_blob_copies '));
    const lastFile = queries.findIndex(query => query.startsWith('DELETE FROM storage_hosts '));
    const fileQueries = queries.splice(firstFile,lastFile-firstFile+1);
    // Document versions reference files; remove their history before the file records.
    queries.splice(queries.findIndex(query => query.startsWith('DELETE FROM committee_seats ')),0,...fileQueries);
    for (const query of queries) await client.query(query,[committee.id]);
    await client.query(`UPDATE committee_deletion_jobs SET status='COMPLETED',completed_at=now(),claimed_at=NULL,
      claim_token=NULL,failure_code=NULL,failure_reason=NULL WHERE committee_id=$1`,[committee.id]);
  }
  const removed = await client.query('DELETE FROM rule_package_versions WHERE id<>$1', [retained.id]);
  await client.query('DELETE FROM rule_packages WHERE id<>$1',[retained.package_id]);
  await client.query(`UPDATE rule_package_versions SET definition=jsonb_set(definition,'{metadata,names}',$2::jsonb) WHERE id=$1`,
    [retained.id,JSON.stringify({'zh-CN':'北京学术标准 2021',en:'Beijing Academic Standard 2021'})]);
  await client.query('ALTER TABLE rule_package_versions ENABLE TRIGGER rule_package_versions_published_immutable');
  if (before !== await preserved()) throw new Error('Account, template or system settings changed; rolling back.');
  await client.query('COMMIT');
  console.log(JSON.stringify({retainedVersionId:retained.id,name:'北京学术标准 2021',removedVersions:removed.rowCount,
    removedCommittees:committees.map(({id,name})=>({id,name})),retainedAccountsTemplatesAndSettings:true}));
} catch (error) {await client.query('ROLLBACK'); throw error;}
finally {client.release();await pool.end();}
