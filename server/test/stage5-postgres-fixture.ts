import {testCommitteeInput} from '../src/test/committee-fixture';
// @vitest-environment node

import {createHash, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe} from 'vitest';
import {runMigrations} from '../src/db/migrations';
import {PostgresIdentityStore} from '../src/modules/identity/postgres';
import {IdentityService} from '../src/modules/identity/service';
import type {AuthenticatedSession} from '../src/modules/identity/store';
import {Stage3Service} from '../src/modules/stage3/service';
import {Stage4Service} from '../src/modules/stage4/service';
import {Stage5Service} from '../src/modules/stage5/service';
import {Stage6StorageService} from '../src/modules/storage/service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = ''; let pool: pg.Pool | undefined; let fixtureSequence = 0;
let identity: IdentityService; let stage3: Stage3Service; let stage4: Stage4Service; let stage5: Stage5Service;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const context = (name: string) => ({requestId: `stage5-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage5_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); } finally { await admin.end(); }
  pool = new Pool({connectionString: url.toString()}); await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool)); stage3 = new Stage3Service(pool);
  stage4 = new Stage4Service(pool); stage5 = new Stage5Service(pool); await stage3.ensureBuiltins();
  const secret = await identity.ensureBootstrapSecret();
  const login = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
    displayName: 'System Admin', password: 'admin-password-123'}, context('bootstrap'));
  administrator = await identity.authenticate(login.sessionToken);
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

async function meetingFixture(requireSecond = false) {
  const suffix = String(++fixtureSequence);
  const owner = await user(`owner${suffix}`); const firstChair = await user(`chairone${suffix}`);
  const secondChair = await user(`chairtwo${suffix}`);
  const firstDelegate = await user(`delegateone${suffix}`); const secondDelegate = await user(`delegatetwo${suffix}`);
  const sameSeatDelegate = await user(`delegatethree${suffix}`);
  const committee = await stage4.createCommittee(owner, await testCommitteeInput(pool!, owner, {name: 'Stage 5 Council', visibility: 'PUBLIC', operationMode: 'DELEGATE_OPERATED',
    countryTemplateKey: 'builtin:default'}), 'committee', context('committee'));
  let revised = await stage3.setChair(owner, committee.id, firstChair.user.email, true, committee.revision, context('chair-one'));
  revised = await stage3.setChair(owner, committee.id, secondChair.user.email, true, revised.revision, context('chair-two'));
  const firstSeat = await stage4.createSeat(firstChair, committee.id, {stableKey: 'first', canVote: true, canProceduralVote: true},
    'seat-first', context('seat-first'));
  const secondSeat = await stage4.createSeat(firstChair, committee.id, {stableKey: 'second', canVote: true, canProceduralVote: true},
    'seat-second', context('seat-second'));
  await stage3.assignSeat(firstChair, committee.id, {seatId: firstSeat.id, email: firstDelegate.user.email}, context('assign-first'));
  await stage3.assignSeat(firstChair, committee.id, {seatId: secondSeat.id, email: secondDelegate.user.email}, context('assign-second'));
  await stage3.assignSeat(firstChair, committee.id, {seatId: firstSeat.id, email: sameSeatDelegate.user.email}, context('assign-third'));
  if (requireSecond) {
    const definition = (await pool!.query('SELECT definition FROM rule_package_versions WHERE id=$1',
      [committee.activeRulePackageVersionId])).rows[0].definition;
    definition.key = 'test:procedural-seconds';
    definition.motions = definition.motions.map((motion: {id: string}) => motion.id === 'open-unmoderated-caucus'
      ? {...motion, requiredSecondCount: 1} : motion);
    const rules = await stage3.importRulePackage(firstChair,
      {scope: 'COMMITTEE', committeeId: committee.id, definition}, context('procedural-rules'));
    const revision = (await pool!.query('SELECT revision FROM committees WHERE id=$1', [committee.id])).rows[0].revision;
    await stage3.activateRules(firstChair, committee.id, rules.versions[0]!.id, revision, context('procedural-rules-activate'));
  }
  const session = await stage4.startMeetingSession(firstChair, committee.id, {}, context('meeting'), randomUUID());
  await stage4.createAttendanceEvent(firstChair, committee.id,
    {meetingSessionId: session.id, seatId: firstSeat.id, type: 'PRESENT'}, context('present-first'));
  await stage4.createAttendanceEvent(firstChair, committee.id,
    {meetingSessionId: session.id, seatId: secondSeat.id, type: 'PRESENT'}, context('present-second'));
  let generalList = (await stage4.snapshot(committee.id, firstChair)).speakerLists?.find(list => list.kind === 'GENERAL');
  if (!generalList) throw new Error('Meeting fixture did not create the main speakers list.');
  generalList = await stage5.setSpeakerListStatus(firstChair, generalList.id,
    {baseRevision: generalList.revision, status: 'OPEN'}, context('open-general'));
  return {owner, committee, session, generalList, firstChair, secondChair, firstDelegate, secondDelegate, sameSeatDelegate, firstSeat, secondSeat};
}

async function meetingEndFixture() {
  const suffix = String(++fixtureSequence);
  const firstChair = await user(`endchair${suffix}`);
  const firstDelegate = await user(`enddelegate${suffix}`);
  const committee = await stage4.createCommittee(firstChair, await testCommitteeInput(pool!, firstChair, {name: 'Meeting lifecycle', visibility: 'PUBLIC',
    countryTemplateKey: 'builtin:default'}), 'end-committee', context('end-committee'));
  const firstSeat = await stage4.createSeat(firstChair, committee.id,
    {stableKey: 'end-first', canVote: true, canProceduralVote: true}, 'end-seat', context('end-seat'));
  const session = await stage4.startMeetingSession(firstChair, committee.id, {}, context('end-meeting'), randomUUID());
  await stage4.createAttendanceEvent(firstChair, committee.id,
    {meetingSessionId: session.id, seatId: firstSeat.id, type: 'PRESENT'}, context('end-present'));
  const generalList = (await stage4.snapshot(committee.id, firstChair)).speakerLists!.find(list => list.kind === 'GENERAL')!;
  return {committee, session, generalList, firstChair, firstDelegate, firstSeat};
}

async function testCrisisNotice(f: Awaited<ReturnType<typeof meetingEndFixture>>, name = 'Crisis Notice 1.1.1') {
  const storage = new Stage6StorageService(pool!);
  const snapshot = await stage4.snapshot(f.committee.id,f.firstChair);
  let binding = (await storage.listBindings(f.firstChair,f.committee.id)).find(binding => binding.status === 'ACTIVE');
  if (!binding) binding = await storage.createServerVolumeBinding(f.firstChair,f.committee.id,{baseRevision: snapshot.committee.revision},randomUUID(),context('crisis-binding'));
  const content = 'Verified crisis notice';
  const file = await storage.recordProviderCommit(f.firstChair,f.committee.id,{bindingId: binding.id,logicalName: name,
    originalName: 'unrelated-999.999.999.pdf',mediaType: 'application/pdf',sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),storageKey: `blobs/${randomUUID().replaceAll('-','')}`},randomUUID(),context('crisis-notice'));
  await pool!.query("UPDATE delegate_file_metadata SET file_type='CRISIS_NOTICE' WHERE file_entry_id=$1",[file.id]);
  return file;
}

async function preparedTestCrisis(f: Awaited<ReturnType<typeof meetingEndFixture>>, name = 'Crisis Notice 1.1.1') {
  const file = await testCrisisNotice(f,name);
  const imported = await stage5.importCrisisNotice(f.firstChair,file.id,{baseRevision: file.revision},randomUUID(),context('crisis-import'));
  const group = (await stage4.snapshot(f.committee.id,f.firstChair)).crises!.find(group => group.id === imported.groupId)!;
  return stage5.updateCrisisCard(f.firstChair,imported.updateId,{baseRevision: group.updates[0]!.revision,title: 'Harbor blockade',handlingDurationMs: 1800000},context('crisis-edit'));
}
async function publishedTestCrisis(f: Awaited<ReturnType<typeof meetingEndFixture>>, name = 'Crisis Notice 1.1.1') {
  const group = await preparedTestCrisis(f,name);
  return stage5.publishCrisis(f.firstChair,group.updates[0]!.id,{baseRevision: group.updates[0]!.revision},randomUUID(),context('crisis-publish'));
}

export {adminUrl, databaseName, pool, identity, stage3, stage4, stage5, administrator, context, integration, user, meetingFixture, meetingEndFixture, testCrisisNotice, preparedTestCrisis, publishedTestCrisis};

export function replacePool(value: pg.Pool): void {pool = value;}
export function replaceStage5(value: Stage5Service): void {stage5 = value;}
