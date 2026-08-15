// @vitest-environment node

import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
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

  it('includes the stage 4 low-concurrency schema as migration 4', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const stage4 = migrations.find(migration => migration.version === 4);
    expect(stage4?.name).toBe('low_concurrency_slices');
    expect(stage4?.sql).toContain('CREATE TABLE meeting_sessions');
    expect(stage4?.sql).toContain('CREATE TABLE idempotency_keys');
    expect(stage4?.sql).not.toContain('CREATE TABLE ballots');
    expect(stage4?.sql).not.toContain('CREATE TABLE timers');
  });

  it('adds retained event cursors for stage 5 SSE', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const realtime = migrations.find(migration => migration.version === 5);
    expect(realtime?.name).toBe('realtime_sse');
    expect(realtime?.sql).toContain('events_retained_from_sequence');
    expect(realtime?.sql).not.toContain('CREATE TABLE timer_states');
  });

  it('adds server-authoritative timer state without per-second rows', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const timers = migrations.find(migration => migration.version === 6);
    expect(timers?.name).toBe('authoritative_timers');
    expect(timers?.sql).toContain('remaining_at_start_ms');
    expect(timers?.sql).not.toContain('timer_ticks');
  });

  it('models GSL as a normal GENERAL speaker list with serialized active positions', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const queues = migrations.find(migration => migration.version === 7);
    expect(queues?.name).toBe('speaker_lists_caucuses');
    expect(queues?.sql).toContain("'GENERAL'");
    expect(queues?.sql).toContain('speaker_queue_one_current');
    expect(queues?.sql).not.toContain("'gsl'");
  });

  it('keeps speech actions and contributions append-only', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const speeches = migrations.find(migration => migration.version === 8);
    expect(speeches?.name).toBe('speech_history_yields');
    expect(speeches?.sql).toContain('speeches_one_active_per_list');
    expect(speeches?.sql).toContain('speech_actions_append_only');
    expect(speeches?.sql).toContain('speech_contributions_append_only');
  });

  it('freezes motion rules behind an explicit database state machine', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const motions = migrations.find(migration => migration.version === 9);
    expect(motions?.name).toBe('motions');
    expect(motions?.sql).toContain('rule_evaluation jsonb NOT NULL');
    expect(motions?.sql).toContain('motions_explicit_state_machine');
    expect(motions?.sql).toContain('UNIQUE (motion_id, seat_id)');
  });

  it('enforces one current vote per ballot seat and append-only corrections', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const ballots = migrations.find(migration => migration.version === 10);
    expect(ballots?.name).toBe('formal_ballots');
    expect(ballots?.sql).toContain('UNIQUE (ballot_id, seat_id)');
    expect(ballots?.sql).toContain('ballot_vote_revisions_append_only');
    expect(ballots?.sql).toContain('ballots_frozen_state_machine');
  });

  it('separates anonymous strawpoll receipts from option selections', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const strawpolls = migrations.find(migration => migration.version === 11);
    expect(strawpolls?.name).toBe('strawpolls');
    expect(strawpolls?.sql).toContain('strawpoll_seat_votes');
    expect(strawpolls?.sql).toContain('strawpoll_anonymous_receipts');
    expect(strawpolls?.sql).toContain('strawpoll_anonymous_votes');
    const anonymousVotes = strawpolls?.sql.split('CREATE TABLE strawpoll_anonymous_votes')[1]?.split(');')[0];
    expect(anonymousVotes).not.toContain('credential_hash');
    expect(anonymousVotes).not.toContain('actor_user_id');
    expect(anonymousVotes).not.toContain('seat_id');
    expect(anonymousVotes).not.toContain('created_at');
  });

  it('keeps proceeding documents versioned and freezes the voting version', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const documents = migrations.find(migration => migration.version === 12);
    expect(documents?.name).toBe('resolution_documents');
    expect(documents?.sql).toContain('CREATE TABLE document_versions');
    expect(documents?.sql).toContain('documents_voting_version_fk');
    expect(documents?.sql).toContain('document voting version is immutable');
    expect(documents?.sql).toContain('documents_explicit_state_machine');
    expect(documents?.sql).toContain('discussion_entries_append_only');
    expect(documents?.sql).not.toContain('file_entries');
    expect(documents?.sql).not.toContain('storage_provider');
  });

  it('adds append-only file versions and tombstones without Chair Agent behavior', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const files = migrations.find(migration => migration.version === 13);
    expect(files?.name).toBe('file_metadata_tombstones');
    expect(files?.sql).toContain('CREATE TABLE storage_bindings');
    expect(files?.sql).toContain('CREATE TABLE file_entries');
    expect(files?.sql).toContain('CREATE TABLE file_versions');
    expect(files?.sql).toContain('CREATE TABLE file_tombstones');
    expect(files?.sql).toContain('file_versions_append_only');
    expect(files?.sql).toContain('file_tombstones_append_only');
    expect(files?.sql).toContain('file_tombstones_integrity');
    expect(files?.sql).toContain('deleted file cannot be revived');
    expect(files?.sql).not.toContain('CHAIR_AGENT');
    expect(files?.sql).not.toContain('lease_generation');
  });

  it('adds durable upload staging without publishing file versions', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const uploads = migrations.find(migration => migration.version === 14);
    expect(uploads?.sql).toContain('CREATE TABLE file_uploads');
    expect(uploads?.sql).toContain("'CREATED', 'RECEIVING', 'STAGED', 'COMMITTED', 'CANCELLED', 'FAILED'");
    expect(uploads?.sql).toContain('expected_size_bytes');
    expect(uploads?.sql).toContain('received_size_bytes');
    expect(uploads?.sql).toContain('expected_sha256');
    expect(uploads?.sql).toContain('actual_sha256');
    expect(uploads?.sql).toContain('staging_key');
    expect(uploads?.sql).toContain("WHERE status IN ('COMMITTED', 'CANCELLED', 'FAILED')");
    expect(uploads?.sql).not.toContain('INSERT INTO file_versions');
    expect(uploads?.sql).not.toContain('CHAIR_AGENT');
  });

  it('binds committed uploads to SERVER_VOLUME blobs and file versions', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const provider = migrations.find(migration => migration.version === 15);
    expect(provider?.sql).toContain('provider_blob_id');
    expect(provider?.sql).toContain('provider_storage_key');
    expect(provider?.sql).toContain('committed_blob_id');
    expect(provider?.sql).toContain('committed_file_entry_id');
    expect(provider?.sql).toContain('committed_file_version_id');
    expect(provider?.sql).not.toContain('S3_COMPATIBLE');
    expect(provider?.sql).not.toContain('CHAIR_AGENT');
  });

  it('stores S3 provider configuration with encrypted credentials and a binding foreign key', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const s3 = migrations.find(migration => migration.version === 16);
    expect(s3?.name).toBe('s3_provider_configs');
    expect(s3?.sql).toContain('CREATE TABLE storage_provider_configs');
    expect(s3?.sql).toContain('credentials_ciphertext bytea');
    expect(s3?.sql).toContain('credentials_nonce bytea');
    expect(s3?.sql).toContain('credentials_auth_tag bytea');
    expect(s3?.sql).toContain('credential_key_version integer');
    expect(s3?.sql).toContain('storage_bindings_provider_config_fk');
    expect(s3?.sql).toContain('storage_bindings_provider_config_required');
    expect(s3?.sql).not.toContain('secret_access_key');
  });

  it('adds review transitions and durable physical-delete jobs', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const review = migrations.find(migration => migration.version === 17);
    expect(review?.name).toBe('file_review_download_delete_jobs');
    expect(review?.sql).toContain('file_entries_review_state');
    expect(review?.sql).toContain('enforce_file_review_transition');
    expect(review?.sql).toContain('new file version must return to upload complete');
    expect(review?.sql).toContain('CREATE TABLE file_blob_delete_jobs');
    expect(review?.sql).toContain("status IN ('PENDING', 'RETRY')");
    expect(review?.sql).toContain("status = 'IN_PROGRESS'");
    expect(review?.sql).toContain('file_blob_delete_jobs_stale_claim');
    expect(review?.sql).toContain('claim_token uuid');
    expect(review?.sql).toContain('UNIQUE (blob_id)');
    expect(review?.sql).toContain('schema_compatibility = 17');
  });

  it('adds fenced provider migrations and immutable blob-copy locations', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const switching = migrations.find(migration => migration.version === 18);
    expect(switching?.name).toBe('storage_provider_migrations');
    expect(switching?.sql).toContain('file_manifest_revision');
    expect(switching?.sql).toContain('verified_revision');
    expect(switching?.sql).toContain('CREATE TABLE storage_migrations');
    expect(switching?.sql).toContain('CREATE TABLE storage_migration_items');
    expect(switching?.sql).toContain('CREATE TABLE file_blob_copies');
    expect(switching?.sql).toContain('claim_token uuid');
    expect(switching?.sql).toContain('storage_migrations_one_open_per_committee');
    expect(switching?.sql).toContain('enforce_file_blob_copy_integrity');
    expect(switching?.sql).toContain('schema_compatibility = 18');
  });

  it('adds fenced staging cleanup and append-only maintenance audit', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const cleanup = migrations.find(migration => migration.version === 19);
    expect(cleanup?.name).toBe('storage_capacity_cleanup');
    expect(cleanup?.sql).toContain('file_uploads_cleanup_claim_state');
    expect(cleanup?.sql).toContain('storage_migration_items_cleanup_claim_state');
    expect(cleanup?.sql).toContain('staging_deleted_at');
    expect(cleanup?.sql).toContain('cleanup_claim_token uuid');
    expect(cleanup?.sql).toContain('CREATE TABLE storage_cleanup_audit');
    expect(cleanup?.sql).toContain('storage cleanup audit records are append-only');
    expect(cleanup?.sql).toContain('schema_compatibility = 19');
  });

  it('adds one-time Agent pairing and single-host fencing', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const agent = migrations.find(migration => migration.version === 20);
    expect(agent?.name).toBe('storage_agent_identity');
    expect(agent?.sql).toContain('CREATE TABLE storage_pairing_codes');
    expect(agent?.sql).toContain('code_hash bytea');
    expect(agent?.sql).toContain('CREATE TABLE storage_hosts');
    expect(agent?.sql).toContain('device_public_key bytea');
    expect(agent?.sql).toContain('credential_hash bytea');
    expect(agent?.sql).toContain('storage_lease_generation');
    expect(agent?.sql).toContain('storage_hosts_one_current_per_committee');
    expect(agent?.sql).not.toContain('pairing_code text');
    expect(agent?.sql).not.toContain('credential text');
    expect(agent?.sql).not.toContain('storage_agent_tasks');
    expect(agent?.sql).toContain('schema_compatibility = 20');
  });

  it('adds append-only Agent manifest events and fenced durable tasks', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const tasks = migrations.find(migration => migration.version === 21);
    expect(tasks?.name).toBe('storage_agent_tasks_manifest');
    expect(tasks?.sql).toContain("'SERVER_VOLUME', 'CHAIR_AGENT', 'S3_COMPATIBLE'");
    expect(tasks?.sql).toContain("provider_type IN ('SERVER_VOLUME','CHAIR_AGENT')");
    expect(tasks?.sql).toContain('CREATE TABLE storage_manifest_events');
    expect(tasks?.sql).toContain('file_versions_storage_manifest');
    expect(tasks?.sql).toContain('file_tombstones_storage_manifest');
    expect(tasks?.sql).toContain('storage manifest events are append-only');
    expect(tasks?.sql).toContain('CREATE TABLE storage_agent_tasks');
    expect(tasks?.sql).toContain('claim_request_id uuid');
    expect(tasks?.sql).toContain('claim_token uuid');
    expect(tasks?.sql).toContain('lease_generation bigint');
    expect(tasks?.sql).toContain('content_staging_key text');
    expect(tasks?.sql).toContain('storage Agent task identity is immutable');
    expect(tasks?.sql).toContain('schema_compatibility = 21');
  });

  it('binds Chair Agent storage to durable host commits and explicit local conflicts', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const provider = migrations.find(migration => migration.version === 22);
    expect(provider?.name).toBe('chair_agent_provider');
    expect(provider?.sql).toContain("'PENDING_HOST_COMMIT', 'SYNCED', 'OUT_OF_SYNC'");
    expect(provider?.sql).toContain('storage_bindings_storage_host_fk');
    expect(provider?.sql).toContain('file_uploads_agent_target_integrity');
    expect(provider?.sql).toContain('storage_agent_tasks_source_upload_once');
    expect(provider?.sql).toContain('CREATE TABLE storage_agent_change_requests');
    expect(provider?.sql).toContain('CREATE TABLE storage_agent_conflicts');
    expect(provider?.sql).toContain("'HOST_TRANSFERRED'");
    expect(provider?.sql).toContain('schema_compatibility=22');
  });

  it('adds fenced and immutable Chair conflict resolutions', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const resolution = migrations.find(item => item.version === 23);
    expect(resolution?.sql).toContain("storage_agent_conflict_resolution AS ENUM ('KEEP_SERVER','ACCEPT_LOCAL','SAVE_AS_NEW')");
    expect(resolution?.sql).toContain('resolution_conflict_id uuid REFERENCES storage_agent_conflicts(id)');
    expect(resolution?.sql).toContain('prevent_storage_agent_conflict_mutation');
    expect(resolution?.sql).toContain('CREATE TABLE storage_agent_conflict_applications');
    expect(resolution?.sql).toContain('storage Agent conflict applications are immutable');
    expect(resolution?.sql).toContain('schema_compatibility=23');
  });

  it('adds durable committee deletion with scoped append-only purge exceptions', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const deletion = migrations.find(item => item.version === 24);
    expect(deletion?.name).toBe('committee_deletion_jobs');
    expect(deletion?.sql).toContain('CREATE TABLE committee_deletion_jobs');
    expect(deletion?.sql).toContain('CREATE TABLE committee_deletion_agent_tasks');
    expect(deletion?.sql).toContain("'PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED'");
    expect(deletion?.sql).toContain('quorum_meta.committee_purge_allowed');
    expect(deletion?.sql).toContain("current_setting('quorum.committee_purge_token',true)");
    expect(deletion?.sql).toContain('storage_agent_tasks_cleanup_candidates');
    expect(deletion?.sql).toContain('DEFERRABLE INITIALLY IMMEDIATE');
    expect(deletion?.sql).toContain('schema_compatibility=24');
  });

  it('adds irreversible account anonymization and durable identity idempotency', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const account = migrations.find(item => item.version === 25);
    expect(account?.name).toBe('account_anonymization');
    expect(account?.sql).toContain('ALTER COLUMN email DROP NOT NULL');
    expect(account?.sql).toContain('users_anonymized_identity_cleared');
    expect(account?.sql).toContain('CREATE TABLE identity_idempotency_keys');
    expect(account?.sql).toContain('prevent_anonymized_user_restore');
    expect(account?.sql).toContain('committee_templates_owner_country_template_fk');
    expect(account?.sql).toContain('DEFERRABLE INITIALLY IMMEDIATE');
    expect(account?.sql).toContain('schema_compatibility = 25');
    expect(account?.sql).toContain('UPDATE system_settings');
  });

  it('adds append-only retention run evidence and candidate indexes', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const retention = migrations.find(item => item.version === 26);
    expect(retention?.name).toBe('retention_policy');
    expect(retention?.sql).toContain('CREATE TABLE operations_retention_runs');
    expect(retention?.sql).toContain('retention run records are append-only');
    expect(retention?.sql).toContain('sessions_retention_candidates');
    expect(retention?.sql).toContain('schema_compatibility = 26');
  });

  it('adds independent legacy motion interaction settings', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const settings = migrations.find(item => item.version === 27);
    expect(settings?.name).toBe('motion_interaction_settings');
    expect(settings?.sql).toContain('delegate_motion_proposals_enabled boolean NOT NULL DEFAULT false');
    expect(settings?.sql).toContain('delegate_motion_voting_enabled boolean NOT NULL DEFAULT false');
    expect(settings?.sql).toContain('schema_compatibility = 27');
  });

  it('keeps retracted ballot votes in append-only history', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const votes = migrations.find(item => item.version === 28);
    expect(votes?.name).toBe('ballot_vote_retractions');
    expect(votes?.sql).toContain('ADD COLUMN retracted_at timestamptz');
    expect(votes?.sql).toContain('ALTER COLUMN new_choice DROP NOT NULL');
    expect(votes?.sql).toContain('ballot_vote_revisions_has_state');
    expect(votes?.sql).toContain('schema_compatibility = 28');
  });

  it('stores local motion destinations and fixes withdrawn decision evidence', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const enactment = migrations.find(item => item.version === 29);
    expect(enactment?.name).toBe('motion_enactment_destinations');
    expect(enactment?.sql).toContain("status IN ('PASSED','FAILED','WITHDRAWN')");
    expect(enactment?.sql).toContain('ADD COLUMN destination_path text');
    expect(enactment?.sql).toContain("destination_path ~ '^/committees/[0-9a-f-]{36}/'");
    expect(enactment?.sql).toContain('document_versions_content_length');
    expect(enactment?.sql).toContain('schema_compatibility = 29');
  });

  it('keeps legacy motion direct votes and setting changes append-only', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 30);
    expect(migration?.sql).toContain('CREATE TABLE motion_direct_votes');
    expect(migration?.sql).toContain('CREATE TABLE motion_direct_vote_revisions');
    expect(migration?.sql).toContain('CREATE TABLE motion_direct_vote_setting_revisions');
    expect(migration?.sql).toContain('motion direct vote history is append-only');
  });

  it('adds the legacy speaker workspace state without client-side persistence', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 31);
    expect(migration?.name).toBe('legacy_speaker_workspace');
    expect(migration?.sql).toContain('delegates_can_queue');
    expect(migration?.sql).toContain('speaker_stance');
    expect(migration?.sql).toContain('speech_duration_ms');
    expect(migration?.sql).toContain('speech_yield_decision_status');
    expect(migration?.sql).toContain("'YIELD_REJECTED'");
    expect(migration?.sql).toContain('schema_compatibility = 31');
  });

  it('keeps legacy resolution votes, settings, and result corrections append-only', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 32);
    expect(migration?.name).toBe('legacy_resolution_workspace');
    expect(migration?.sql).toContain('CREATE TABLE resolution_direct_votes');
    expect(migration?.sql).toContain('CREATE TABLE resolution_direct_vote_revisions');
    expect(migration?.sql).toContain('CREATE TABLE document_result_decisions');
    expect(migration?.sql).toContain('legacy document history is append-only');
    expect(migration?.sql).toContain('schema_compatibility=32');
  });

  it('adds legacy strawpoll rounds, vote changes, and manual tallies without replacing anonymous receipts', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 33);
    expect(migration?.name).toBe('legacy_strawpoll_rounds');
    expect(migration?.sql).toContain('strawpolls_series_round_unique');
    expect(migration?.sql).toContain('CREATE TABLE strawpoll_seat_vote_revisions');
    expect(migration?.sql).toContain('CREATE TABLE strawpoll_manual_tally_revisions');
    expect(migration?.sql).not.toContain('DROP TABLE strawpoll_anonymous_receipts');
    expect(migration?.sql).toContain('schema_compatibility=33');
  });

  it('allows an unintroduced resolution draft to exist before a proposer or body is recorded', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 34);
    expect(migration?.name).toBe('draft_resolution_introduction');
    expect(migration?.sql).toContain('length(content) BETWEEN 0 AND 200000');
    expect(migration?.sql).toContain('created_on_behalf_of_seat_id DROP NOT NULL');
    expect(migration?.sql).toContain('proposer_seat_id DROP NOT NULL');
    expect(migration?.sql).toContain('schema_compatibility=34');
  });

  it('stores a resolution version as either text or one uploaded file', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 35);
    expect(migration?.name).toBe('resolution_file_content');
    expect(migration?.sql).toContain('content_file_entry_id uuid REFERENCES file_entries(id)');
    expect(migration?.sql).toContain("content_file_entry_id IS NULL OR content=''");
    expect(migration?.sql).toContain('schema_compatibility=35');
  });

  it('associates at most one moderated caucus with a resolution draft', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 36);
    expect(migration?.name).toBe('resolution_linked_caucus');
    expect(migration?.sql).toContain('linked_resolution_document_id uuid REFERENCES resolutions(document_id)');
    expect(migration?.sql).toContain('speaker_lists_one_caucus_per_resolution');
    expect(migration?.sql).toContain('schema_compatibility=36');
  });

  it('retains deleted amendments while hiding them from active document snapshots', async () => {
    const migration = (await loadMigrations(resolve('server/migrations')))
      .find(item => item.version === 37);
    expect(migration?.name).toBe('amendment_workflow');
    expect(migration?.sql).toContain('ADD COLUMN deleted_at timestamptz');
    expect(migration?.sql).toContain('documents_deletion_metadata_complete');
    expect(migration?.sql).toContain('schema_compatibility=37');
  });

  it('persists legacy workspace layout settings and one main speakers list per meeting', async () => {
    const migrations = await loadMigrations(resolve('server/migrations'));
    const migration = migrations.find(item => item.version === 38);
    expect(migration?.sql).toContain('move_queue_up boolean');
    expect(migration?.sql).toContain('timers_in_separate_columns boolean');
    expect(migration?.sql).toContain("WHERE kind = 'GENERAL'");
    expect(migration?.sql).toContain("WHERE session.status='OPEN'");
    expect(migration?.sql).toContain("item->>'defaultDurationSeconds'");
    expect(migration?.sql).toContain('migration.main_speaker_list_backfilled');
    expect(migration?.sql).toContain('schema_compatibility=38');
  });

  it('allows logical deletion to clear the reviewed file current version', async () => {
    const migration = (await loadMigrations(resolve('server/migrations'))).find(item => item.version === 39);
    expect(migration?.name).toBe('file_delete_review_transition');
    expect(migration?.sql).toContain("NEW.status NOT IN ('UPLOAD_COMPLETE', 'DELETED')");
    expect(migration?.sql).toContain('schema_compatibility=39');
  });

  it('rejects SQL files outside the versioned naming contract', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'first.sql'), 'SELECT 1;\n');

    await expect(loadMigrations(directory)).rejects.toThrow('Invalid migration filename');
  });
});
