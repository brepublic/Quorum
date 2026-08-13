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

  it('rejects SQL files outside the versioned naming contract', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'first.sql'), 'SELECT 1;\n');

    await expect(loadMigrations(directory)).rejects.toThrow('Invalid migration filename');
  });
});
