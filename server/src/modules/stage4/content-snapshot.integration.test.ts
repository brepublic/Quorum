// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from '../stage3/service';
import {Stage8ArchiveService} from '../operations/archive-service';
import {Stage4Service} from './service';
import {Stage5Service} from '../stage5/service';

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
  databaseName = `quorum_content_${randomUUID().replaceAll('-', '')}`;
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
    newPassword: `${name}-permanent-password-123`
  }, context(`password-${name}`));
  return identity.authenticate(changed.sessionToken);
}

const countryTemplate = {names: {en: 'Countries', 'zh-CN': '国家'}, defaultLanguage: 'en', countryLanguages: ['en', 'zh-CN'],
  countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', continent: 'Asia', sortOrder: 1,
    flag: {type: 'STANDARD' as const, value: 'cn'}}]};

const committeeTemplate = (countryTemplateKey: string) => ({names: {en: 'Council'}, defaultLanguage: 'en', countryTemplateKey,
  members: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', rank: 'STANDARD' as const,
    canVote: true, hasVeto: true, mustVote: false, sortOrder: 1, flag: {type: 'STANDARD' as const, value: 'cn'}}]});

integration('immutable committee content', () => {
  async function fixture() {
    const owner = await user('snapshot');
    const countries = await stage4.createCountryTemplate(owner, countryTemplate, randomUUID(), context('countries'));
    const template = await stage4.createCommitteeTemplate(owner, committeeTemplate(countries.key), randomUUID(), context('template'));
    const rules = (await stage3.listRulePackages(owner)).find(item => item.scope === 'BUILTIN')!;
    const version = rules.versions.at(-1)!;
    const input = {name: 'Snapshot', visibility: 'PUBLIC', committeeLanguage: 'en',
      committeeTemplateId: template.id, committeeTemplateRevision: template.revision,
      countryTemplateRevision: countries.revision, activeRulePackageVersionId: version.id};
    return {owner, countries, template, input};
  }

  it('keeps the full directory and initial members after source edits and deletion', async () => {
    const {owner, countries, template, input} = await fixture();
    const committee = await stage4.createCommittee(owner, input, randomUUID(), context('create'));
    expect(committee.committeeLanguage).toBe('en');
    await stage4.updateCountryTemplate(owner, countries.id, {baseRevision: countries.revision,
      template: {...countryTemplate, countries: [{...countryTemplate.countries[0], names: {en: 'Changed', 'zh-CN': '改名'}}]}}, context('edit'));
    await stage4.deleteCommitteeTemplate(owner, template.id, context('delete-template'));
    await stage4.deleteCountryTemplate(owner, countries.id, context('delete-countries'));
    const snapshot = await stage4.snapshot(committee.id, owner);
    expect(snapshot.countryTemplate?.countries[0]?.names.en).toBe('China');
    expect(snapshot.seats[0]).toMatchObject({displayName: 'China', flag: {type: 'STANDARD', value: 'cn'}});
    const saved = (await pool!.query('SELECT content_snapshot FROM committees WHERE id=$1', [committee.id])).rows[0].content_snapshot;
    expect(saved.committeeTemplate.members[0].names.en).toBe('China');
    expect(saved.initialRulePackageVersionId).toBe(input.activeRulePackageVersionId);
    expect((await stage4.snapshot(committee.id)).countryTemplate).toBeUndefined();
    const future = await stage3.overrideRule(owner, committee.id, {scope: 'FUTURE',
      path: 'ballots.chairMayCorrectVote', value: false}, context('unactivated-rules'));
    expect((await stage4.snapshot(committee.id, owner)).activeRules.versionId).toBe(input.activeRulePackageVersionId);
    const revision = (await pool!.query('SELECT revision FROM committees WHERE id=$1', [committee.id])).rows[0].revision;
    await stage3.archiveCommittee(owner, committee.id, revision, context('archive'));
    const exported = await new Stage8ArchiveService(pool!).exportCommittee(owner, committee.id);
    const chunks: string[] = [];
    for await (const chunk of exported.content) chunks.push(String(chunk));
    const records = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
    expect(records[0]).toMatchObject({schemaVersion: 2, committee: {committeeLanguage: 'en', contentSnapshot: saved}});
    expect(records.find(record => record.section === 'rule_versions' && record.record.id === input.activeRulePackageVersionId).record).toMatchObject({id: input.activeRulePackageVersionId, definition: expect.any(Object)});
    expect(records.filter(record => record.section === 'rule_versions').map(record => record.record.id))
      .toEqual(expect.arrayContaining([input.activeRulePackageVersionId, future.createdVersionId]));
    expect(records.find(record => record.section === 'committee_seats').record).toMatchObject({display_name: 'China', flag_value: 'cn'});
  });

  it('validates and freezes default rejection translations during creation', async () => {
    const {owner, input} = await fixture();
    const original = (await pool!.query('SELECT default_file_rejection_types FROM system_settings')).rows[0].default_file_rejection_types;
    const committee = await stage4.createCommittee(owner, input, randomUUID(), context('create'));
    const chineseOnly = original.map((item: {label: Record<string, string>; message: Record<string, string>}) =>
      ({...item, label: {'zh-CN': item.label['zh-CN']}, message: item.message['zh-CN'] ? {'zh-CN': item.message['zh-CN']} : {}}));
    await pool!.query('UPDATE system_settings SET default_file_rejection_types=$1', [JSON.stringify(chineseOnly)]);
    await expect(stage4.createCommittee(owner, input, randomUUID(), context('missing-default')))
      .rejects.toMatchObject({reason: 'MISSING_CONTENT_TRANSLATION', fieldErrors: [
        {field: 'rejectionTypes.0.label', reason: 'MISSING_CONTENT_TRANSLATION', params: {language: 'en'}}]});
    const stored = (await pool!.query('SELECT delegate_file_settings FROM committees WHERE id=$1', [committee.id])).rows[0].delegate_file_settings;
    expect(stored.rejectionTypes).toEqual(original);
    expect(Number((await pool!.query('SELECT count(*) FROM committees')).rows[0].count)).toBe(1);
  });

  it('rejects missing translations and stale revisions without partial creation', async () => {
    const {owner, countries, input} = await fixture();
    await expect(stage4.createCommittee(owner, {...input, committeeLanguage: 'fr'}, randomUUID(), context('bad')))
      .rejects.toMatchObject({reason: 'INVALID_COMMITTEE_LANGUAGE'});
    await expect(stage4.createCommittee(owner, {...input, countryTemplateRevision: 999}, randomUUID(), context('stale')))
      .rejects.toMatchObject({reason: 'SOURCE_REVISION_CHANGED'});
    const updated = await stage4.updateCountryTemplate(owner, countries.id, {baseRevision: countries.revision,
      template: {...countryTemplate, countryLanguages: ['en'], countries: [{...countryTemplate.countries[0], names: {en: 'China'}}]}}, context('edit'));
    await expect(stage4.createCommittee(owner, {...input, committeeLanguage: 'zh-CN', countryTemplateRevision: updated.revision}, randomUUID(), context('missing')))
      .rejects.toMatchObject({reason: 'MISSING_CONTENT_TRANSLATION'});
    expect((await pool!.query('SELECT count(*)::int AS count FROM committees')).rows[0].count).toBe(0);
  });

  it('creates from the complete fixed directory and rejects incompatible rule activation', async () => {
    const {owner, input} = await fixture();
    const {committeeTemplateId, committeeTemplateRevision, ...rest} = input;
    const countries = (await stage4.listCountryTemplates(owner)).find(item => item.key === 'builtin:default')!;
    const committee = await stage4.createCommittee(owner, {...rest, committeeLanguage: 'zh-CN',
      countryTemplateKey: countries.key, countryTemplateRevision: countries.revision}, randomUUID(), context('plain'));
    const country = countries.countries.find(item => item.flag.value === 'cn')!;
    const seat = await stage3.createSeat(owner, committee.id, {stableKey: country.stableKey}, context('seat'), randomUUID());
    expect(seat.displayName).toBe(country.names['zh-CN']);
    const rules = (await stage3.listRulePackages(owner)).find(pkg => pkg.scope === 'BUILTIN')!;
    expect(rules.versions.at(-1)?.languageAvailability.supportedLanguages).toEqual(['zh-CN', 'en']);
    expect(rules.versions[0]?.definition).toBeUndefined();
    // Keep the incompatible historical-rule scenario explicit; it is no longer seeded in production.
    const oldDefinition = JSON.parse(await readFile('packages/rule-schema/fixtures/quorum-default.v1.json', 'utf8'));
    const legacyId = randomUUID(); const packageId = randomUUID();
    await pool!.query(`INSERT INTO rule_packages (id,scope,stable_key) VALUES ($1,'BUILTIN','test:legacy-rule')`, [packageId]);
    await pool!.query(`INSERT INTO rule_package_versions (id,package_id,version,status,definition,schema_version,published_at)
      VALUES ($1,$2,1,'PUBLISHED',$3,1,now())`, [legacyId, packageId, oldDefinition]);
    const historical = (await stage3.listRulePackages(owner)).find(pkg => pkg.id === packageId)!;
    expect(historical.versions[0]?.languageAvailability.supportedLanguages).toEqual([]);
    await expect(stage3.activateRules(owner, committee.id, legacyId, committee.revision, context('activate')))
      .rejects.toMatchObject({reason: 'MISSING_CONTENT_TRANSLATION'});
  });

  it('keeps a coherent source revision when an edit races creation', async () => {
    const {owner, countries, input} = await fixture();
    const [created] = await Promise.allSettled([
      stage4.createCommittee(owner, input, randomUUID(), context('racing-create')),
      stage4.updateCountryTemplate(owner, countries.id, {baseRevision: countries.revision,
        template: {...countryTemplate, countries: [{...countryTemplate.countries[0], names: {en: 'Changed', 'zh-CN': '改名'}}]}}, context('racing-edit'))
    ]);
    if (created.status === 'fulfilled') {
      const directory = (await stage4.snapshot(created.value.id, owner)).countryTemplate!;
      expect(directory.revision).toBe(countries.revision);
      expect(directory.countries[0]?.names.en).toBe('China');
    } else expect(created.reason).toMatchObject({reason: 'SOURCE_REVISION_CHANGED'});
  });

  it.each(['suspend-meeting', 'adjourn-meeting'])('keeps the allocated pending ordinal through %s and resume', async motionTypeId => {
    const {owner, input} = await fixture();
    const committee = await stage4.createCommittee(owner, {...input, operationMode: 'CHAIR_OPERATED'}, randomUUID(), context('create'));
    const first = await stage4.startMeetingSession(owner, committee.id, {}, context('start'), randomUUID());
    const before = await stage4.snapshot(committee.id, owner);
    const seat = before.seats[0]!;
    await stage4.createAttendanceEvent(owner, committee.id, {meetingSessionId: first.id, seatId: seat.id, type: 'PRESENT'}, context('present'));
    const stage5 = new Stage5Service(pool!);
    const motion = await stage5.proposeMotion(owner, committee.id,
      {meetingSessionId: first.id, motionTypeId, onBehalfOfSeatId: seat.id, parameters: {}}, randomUUID(), context('motion'));
    await stage5.decideMotion(owner, motion.id, {baseRevision: motion.revision, result: 'PASSED'}, context('pass'));
    const pending = (await stage4.snapshot(committee.id, owner)).meetingSession!;
    expect(pending).toMatchObject({ordinal: 2, name: 'Session 2', status: 'PENDING'});
    const resumed = await stage4.startMeetingSession(owner, committee.id, {}, context('resume'), randomUUID());
    expect(resumed).toMatchObject({id: pending.id, ordinal: 2, name: 'Session 2', status: 'OPEN'});
    const after = await stage4.snapshot(committee.id, owner);
    expect(after.nextMeetingSessionOrdinal).toBe(3);
    expect(after.speakerLists?.find(item => item.kind === 'GENERAL')?.id).toBe(before.speakerLists?.find(item => item.kind === 'GENERAL')?.id);
  });

  it('keeps poll questions explicit and speaker titles distinct from automatic names', async () => {
    const {owner, input} = await fixture();
    const committee = await stage4.createCommittee(owner, input, randomUUID(), context('create'));
    const session = await stage4.startMeetingSession(owner, committee.id, {}, context('start'), randomUUID());
    const stage5 = new Stage5Service(pool!);
    const request = {meetingSessionId: session.id, question: '', votingMode: 'SEAT_AUTHENTICATED',
      multipleChoice: false, options: ['Yes', 'No'], medium: 'MANUAL'};
    const key = randomUUID();
    const [first, retry] = await Promise.all([
      stage5.createStrawpoll(owner, committee.id, request, key, context('poll')),
      stage5.createStrawpoll(owner, committee.id, request, key, context('retry'))
    ]);
    expect(first).toMatchObject({id: retry.id, ordinal: 1, question: '', stage: 'PREPARING'});
    const custom = await stage5.createStrawpoll(owner, committee.id, {...request, question: 'New strawpoll 1'},
      randomUUID(), context('custom-poll'));
    expect(custom).toMatchObject({ordinal: 2, question: 'New strawpoll 1', stage: 'VOTING'});
    await expect(pool!.query('UPDATE strawpolls SET ordinal=99 WHERE id=$1', [custom.id])).rejects.toThrow();
    const list = (await stage4.snapshot(committee.id, owner)).speakerLists!.find(item => item.kind === 'GENERAL')!;
    expect(list).toMatchObject({customTitle: null, name: "General Speaker's List"});
    const renamed = await stage5.updateSpeakerList(owner, list.id,
      {baseRevision: list.revision, customTitle: '主发言名单'}, context('rename'));
    expect(renamed).toMatchObject({customTitle: '主发言名单', name: '主发言名单'});
    const restored = await stage5.updateSpeakerList(owner, list.id,
      {baseRevision: renamed.revision, customTitle: null}, context('restore'));
    expect(restored).toMatchObject({customTitle: null, name: "General Speaker's List"});
  });

  it('allocates document numbers and preserves explicit titles that look automatic', async () => {
    const {owner, input} = await fixture();
    const committee = await stage4.createCommittee(owner, {...input, committeeLanguage: 'zh-CN'}, randomUUID(), context('create'));
    const session = await stage4.startMeetingSession(owner, committee.id, {}, context('start'), randomUUID());
    const stage5 = new Stage5Service(pool!);
    const request = {meetingSessionId: session.id, customTitle: null, content: ''};
    const key = randomUUID();
    const [first, replay] = await Promise.all([
      stage5.createResolution(owner, committee.id, request, key, context('first')),
      stage5.createResolution(owner, committee.id, request, key, context('retry'))
    ]);
    expect(first).toMatchObject({ordinal: 1, customTitle: null, title: '决议草案 1.1'});
    expect(replay).toEqual(first);
    const custom = await stage5.createResolution(owner, committee.id, {...request, customTitle: 'New amendment 1'}, randomUUID(), context('custom'));
    expect(custom).toMatchObject({ordinal: 2, customTitle: 'New amendment 1', title: 'New amendment 1'});
    const seat = (await stage4.snapshot(committee.id, owner)).seats[0]!;
    await stage4.createAttendanceEvent(owner, committee.id, {meetingSessionId: session.id, seatId: seat.id, type: 'PRESENT'}, context('present'));
    const changed = await stage5.createDocumentVersion(owner, custom.id, {baseRevision: custom.revision,
      customTitle: null, content: 'Body', onBehalfOfSeatId: seat.id}, context('restore-default'));
    expect(changed).toMatchObject({ordinal: 2, customTitle: null, title: '决议草案 1.2'});
    await pool!.query("UPDATE documents SET status='PUBLISHED',is_public=true WHERE id=$1", [first.id]);
    const amendment = await stage5.createAmendment(owner, first.id, {...request, onBehalfOfSeatId: seat.id}, randomUUID(), context('amendment'));
    expect(amendment).toMatchObject({ordinal: 1, customTitle: null, title: '新修正案1'});
    await stage5.deleteAmendment(owner, amendment.id, {baseRevision: amendment.revision}, context('delete'));
    const next = await stage5.createAmendment(owner, first.id, {...request, customTitle: '第1会期', onBehalfOfSeatId: seat.id}, randomUUID(), context('amendment-next'));
    expect(next).toMatchObject({ordinal: 2, customTitle: '第1会期', title: '第1会期'});
    await expect(pool!.query('UPDATE documents SET ordinal=10 WHERE id=$1', [next.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query('UPDATE committees SET next_amendment_ordinal=1 WHERE id=$1', [committee.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query('UPDATE meeting_sessions SET next_resolution_ordinal=1 WHERE id=$1', [session.id])).rejects.toMatchObject({code: '23514'});
    const snapshot = await stage4.snapshot(committee.id, owner);
    expect(snapshot.documents?.find(item => item.id === next.id)?.title).toBe('第1会期');
  });

  it('allocates permanent session ordinals and replays concurrent start requests', async () => {
    const {owner, input} = await fixture();
    const committee = await stage4.createCommittee(owner, input, randomUUID(), context('create'));
    const key = randomUUID();
    const [first, replay] = await Promise.all([
      stage4.startMeetingSession(owner, committee.id, {}, context('start'), key),
      stage4.startMeetingSession(owner, committee.id, {}, context('retry'), key)
    ]);
    expect(first).toMatchObject({ordinal: 1, name: 'Session 1'});
    expect(replay).toEqual(first);
    await expect(stage4.startMeetingSession(owner, committee.id, {phaseId: first.phaseId}, context('conflict'), key))
      .rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    await expect(stage4.startMeetingSession(owner, committee.id, {}, context('already-open'), randomUUID()))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage4.closeMeetingSession(owner, first.id, {baseRevision: first.revision}, context('close'));
    const removed = randomUUID();
    await pool!.query(`INSERT INTO meeting_sessions (id,committee_id,phase_id,active_rule_package_version_id,status,created_by_user_id,closed_at)
      VALUES ($1,$2,$3,$4,'CLOSED',$5,now())`, [removed, committee.id, first.phaseId, input.activeRulePackageVersionId, owner.user.id]);
    await pool!.query('DELETE FROM meeting_sessions WHERE id=$1', [removed]);
    const third = await stage4.startMeetingSession(owner, committee.id, {}, context('third'), randomUUID());
    expect(third).toMatchObject({ordinal: 3, name: 'Session 3'});
    await pool!.query("UPDATE meeting_sessions SET created_at='2000-01-01' WHERE id=$1", [third.id]);
    const snapshot = await stage4.snapshot(committee.id, owner);
    expect(snapshot.meetingSessions?.find(item => item.id === third.id)).toMatchObject({ordinal: 3, name: 'Session 3'});
    expect(snapshot.nextMeetingSessionOrdinal).toBe(4);
    await expect(pool!.query('UPDATE meeting_sessions SET ordinal=7 WHERE id=$1', [third.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query('UPDATE committees SET next_session_ordinal=1 WHERE id=$1', [committee.id])).rejects.toMatchObject({code: '23514'});
    const chinese = await stage4.createCommittee(owner, {...input, committeeLanguage: 'zh-CN'}, randomUUID(), context('chinese'));
    expect(await stage4.startMeetingSession(owner, chinese.id, {}, context('chinese-session'), randomUUID()))
      .toMatchObject({ordinal: 1, name: '第1会期'});
  });

  it('guards immutable identities in both API and SQL and binds retries to content choices', async () => {
    const {owner, input} = await fixture();
    const key = randomUUID();
    const committee = await stage3.createCommittee(owner, input, context('create'), key);
    expect(await stage4.createCommittee(owner, input, key, context('retry'))).toEqual(committee);
    await expect(stage4.createCommittee(owner, {...input, committeeLanguage: 'zh-CN'}, key, context('retry-changed')))
      .rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    const seat = (await stage4.snapshot(committee.id, owner)).seats[0]!;
    await expect(stage4.createSeat(owner, committee.id, {stableKey: 'unknown'}, randomUUID(), context('seat')))
      .rejects.toMatchObject({reason: 'UNKNOWN_FIXED_MEMBER'});
    await expect(stage4.createSeat(owner, committee.id, {stableKey: 'china', displayName: 'Renamed'}, randomUUID(), context('seat')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    await expect(pool!.query("UPDATE committees SET committee_language='zh-CN' WHERE id=$1", [committee.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query("UPDATE committees SET content_snapshot='{}' WHERE id=$1", [committee.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query("UPDATE committee_seats SET display_name='Renamed' WHERE id=$1", [seat.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query("UPDATE committee_seats SET flag_value='us' WHERE id=$1", [seat.id])).rejects.toMatchObject({code: '23514'});
    await expect(pool!.query("UPDATE committee_seats SET stable_key='other' WHERE id=$1", [seat.id])).rejects.toMatchObject({code: '23514'});
  });
});
