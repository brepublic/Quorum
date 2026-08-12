// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage4Service} from './service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let stage4: Stage4Service;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const context = (name: string) => ({requestId: `stage4-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage4_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); } finally { await admin.end(); }
  pool = new Pool({connectionString: url.toString()});
  await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool));
  stage3 = new Stage3Service(pool); stage4 = new Stage4Service(pool);
  await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const session = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(session.sessionToken);
});

afterEach(async () => {
  await pool?.end(); pool = undefined;
  if (!adminUrl || !databaseName) return;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`); }
  finally { await admin.end(); databaseName = ''; }
});

async function user(name: string): Promise<AuthenticatedSession> {
  const created = await identity.createUser(administrator, {email: `${name}@example.com`, displayName: name}, context(`create-${name}`));
  const login = await identity.login({email: created.user.email, password: created.temporaryPassword}, context(`login-${name}`));
  const changed = await identity.changePassword(await identity.authenticate(login.sessionToken), {
    currentPassword: created.temporaryPassword, newPassword: `${name}-permanent-password-123`
  }, context(`password-${name}`));
  return identity.authenticate(changed.sessionToken);
}

const countryTemplate = {names: {en: 'Countries', 'zh-CN': '国家'}, defaultLanguage: 'en', countryLanguages: ['en', 'zh-CN'],
  countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', continent: 'Asia', sortOrder: 1,
    flag: {type: 'STANDARD' as const, value: 'cn'}}]};

const committeeTemplate = (countryTemplateKey: string) => ({names: {en: 'Council'}, defaultLanguage: 'en', countryTemplateKey,
  members: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', rank: 'VETO' as const,
    canVote: true, hasVeto: true, mustVote: false, sortOrder: 1, flag: {type: 'STANDARD' as const, value: 'cn'}}]});

integration('PostgreSQL stage 4 templates and seat snapshots', () => {
  it('isolates account templates, protects references, snapshots seats, and enforces revisions and Chair capability', async () => {
    const owner = await user('templateowner'); const other = await user('templateother'); const chair = await user('templatechair');
    const countries = await stage4.createCountryTemplate(owner, countryTemplate, 'countries-one', context('countries'));
    const retried = await stage4.createCountryTemplate(owner, countryTemplate, 'countries-one', context('countries-retry'));
    expect(retried.id).toBe(countries.id);
    expect((await stage4.listCountryTemplates(administrator)).map(item => item.id)).toEqual(['builtin:default']);
    await expect(stage4.getCountryTemplate(other, countries.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(stage4.deleteCountryTemplate(owner, 'builtin:default', context('delete-builtin')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});

    const first = await stage4.createCommitteeTemplate(owner, committeeTemplate(countries.key), 'committee-one', context('template-one'));
    const second = await stage4.createCommitteeTemplate(owner, {...committeeTemplate(countries.key), names: {en: 'Second'}},
      'committee-two', context('template-two'));
    await expect(stage4.deleteCountryTemplate(owner, countries.id, context('delete-used'))).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT', details: {templates: expect.arrayContaining([expect.objectContaining({id: first.id}), expect.objectContaining({id: second.id})])}
    });
    const clone = await stage4.cloneCommitteeTemplate(owner, first.id, {}, 'clone-one', context('clone'));
    expect(clone.id).not.toBe(first.id);
    await expect(stage4.updateCommitteeTemplate(owner, first.id, {baseRevision: 99, template: committeeTemplate(countries.key)}, context('stale-template')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 1}});

    const committee = await stage4.createCommittee(owner, {name: 'Snapshot Council', visibility: 'PRIVATE', committeeTemplateId: first.id},
      'committee-create', context('committee-create'));
    const seatsBefore = await pool?.query('SELECT stable_key,display_name,rank,can_vote,has_veto,must_vote,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]);
    expect(seatsBefore?.rows).toEqual([expect.objectContaining({stable_key: 'china', display_name: 'China', rank: 'VETO',
      can_vote: true, has_veto: true, must_vote: false, flag_type: 'STANDARD', flag_value: 'cn'})]);
    await stage4.updateCommitteeTemplate(owner, first.id, {baseRevision: 1, template: {...committeeTemplate(countries.key),
      members: [{...committeeTemplate(countries.key).members[0]!, names: {en: 'Changed'}, flag: {type: 'EMOJI', value: '🏳️'}}]}}, context('change-source'));
    expect((await pool?.query('SELECT display_name,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]))?.rows)
      .toEqual([{display_name: 'China', flag_type: 'STANDARD', flag_value: 'cn'}]);
    await stage4.deleteCommitteeTemplate(owner, first.id, context('delete-source-template'));
    expect((await pool?.query('SELECT source_committee_template_id FROM committees WHERE id=$1', [committee.id]))?.rows)
      .toEqual([{source_committee_template_id: null}]);
    expect((await pool?.query('SELECT display_name,flag_type,flag_value FROM committee_seats WHERE committee_id=$1', [committee.id]))?.rows)
      .toEqual([{display_name: 'China', flag_type: 'STANDARD', flag_value: 'cn'}]);

    await expect(stage4.createSeat(owner, committee.id, {stableKey: 'france', displayName: 'France'}, 'owner-seat', context('owner-seat')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage4.createSeat(administrator, committee.id, {stableKey: 'france', displayName: 'France'}, 'admin-seat', context('admin-seat')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const withChair = await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('grant-chair'));
    expect(withChair.revision).toBe(2);
    const seat = await stage4.createSeat(chair, committee.id, {stableKey: 'france', displayName: 'France', rank: 'VETO',
      canVote: true, hasVeto: true, mustVote: true, flag: {type: 'STANDARD', value: 'fr'}}, 'chair-seat', context('chair-seat'));
    const renamed = await stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1,
      patch: {displayName: '法兰西', flag: {type: 'EMOJI', value: '🇫🇷'}}}, context('rename-seat'));
    expect(renamed).toEqual(expect.objectContaining({displayName: '法兰西', revision: 2, mustVote: true}));
    await expect(stage4.updateSeat(chair, committee.id, seat.id, {baseRevision: 1, patch: {sortOrder: 4}}, context('stale-seat')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 2}});
  });
});
