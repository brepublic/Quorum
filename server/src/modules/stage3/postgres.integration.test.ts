// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {freezeRuleEvaluation} from '@quorum/contracts';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from '../identity/postgres';
import {IdentityService} from '../identity/service';
import type {AuthenticatedSession} from '../identity/store';
import {Stage3Service} from './service';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let pool: pg.Pool | undefined;
let identity: IdentityService;
let stage3: Stage3Service;
let administrator: AuthenticatedSession;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const context = (name: string) => ({requestId: `stage3-${name}`, sourceIp: '127.0.0.1', userAgent: 'Vitest'});

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_stage3_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  const admin = new Client({connectionString: adminUrl}); await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`); } finally { await admin.end(); }
  pool = new Pool({connectionString: url.toString()});
  await runMigrations(pool, resolve('server/migrations'));
  identity = new IdentityService(new PostgresIdentityStore(pool));
  stage3 = new Stage3Service(pool);
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

integration('PostgreSQL stage 3 integration', () => {
  it('keeps owner, Chair, membership, assignment, and system administration independent', async () => {
    const owner = await user('owner'); const chair = await user('chair'); const member = await user('member');
    const created = await stage3.createCommittee(owner, {name: 'Private Committee', visibility: 'PRIVATE'}, context('committee'));
    expect(created.ownerUserId).toBe(owner.user.id);
    await expect(stage3.setOperationMode(owner, created.id, 'CHAIR_OPERATED', 1, context('owner-mode')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage3.setOperationMode(administrator, created.id, 'CHAIR_OPERATED', 1, context('admin-mode')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});

    const afterGrant = await stage3.setChair(owner, created.id, chair.user.id, true, 1, context('grant'));
    expect(afterGrant.revision).toBe(2);
    await expect(stage3.setChair(member, created.id, member.user.id, true, 2, context('member-grant')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const operated = await stage3.setOperationMode(chair, created.id, 'CHAIR_OPERATED', 2, context('chair-mode'));
    expect(operated).toEqual(expect.objectContaining({operationMode: 'CHAIR_OPERATED', revision: 3}));
    expect(await stage3.setCommitteeStatus(chair, created.id, 'PAUSED', 3, context('pause')))
      .toEqual(expect.objectContaining({status: 'PAUSED', revision: 4}));
    expect(await stage3.setCommitteeStatus(chair, created.id, 'ACTIVE', 4, context('resume')))
      .toEqual(expect.objectContaining({status: 'ACTIVE', revision: 5}));
    await expect(stage3.setCommitteeStatus(owner, created.id, 'PAUSED', 5, context('owner-pause')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage3.updateCommittee(chair, created.id, 5, {name: 'Changed Owner'}, context('chair-update')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage3.snapshot(created.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(stage3.snapshot(created.id, member)).rejects.toMatchObject({code: 'NOT_FOUND'});

    const seat = await stage3.createSeat(chair, created.id, {stableKey: 'china', displayName: '中国'}, context('seat'));
    await expect(stage3.assignSeat(owner, created.id, {seatId: seat.id, userId: member.user.id}, context('owner-assign')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await stage3.assignSeat(chair, created.id, {seatId: seat.id, userId: member.user.id}, context('chair-assign'));
    const memberSnapshot = await stage3.snapshot(created.id, member);
    expect(memberSnapshot.viewer).toEqual({audience: 'MEMBER', seatId: seat.id});
    expect(memberSnapshot.committee.ownerUserId).toBeUndefined();
    expect(memberSnapshot.chairs).toBeUndefined();
    const chairSnapshot = await stage3.snapshot(created.id, chair);
    expect(chairSnapshot.chairs).toEqual([{userId: chair.user.id}]);
    expect(chairSnapshot.assignments).toEqual(expect.arrayContaining([expect.objectContaining({userId: member.user.id})]));

    await expect(stage3.updateCommittee(owner, created.id, 1, {name: 'Stale'}, context('stale')))
      .rejects.toMatchObject({code: 'REVISION_CONFLICT', details: {currentRevision: 5}});
    await expect(stage3.updateCommittee(owner, created.id, 5, {name: 'Must Roll Back'},
      {requestId: null} as unknown as ReturnType<typeof context>)).rejects.toThrow();
    const afterRollback = await stage3.snapshot(created.id, owner);
    expect(afterRollback.committee).toEqual(expect.objectContaining({name: 'Private Committee', revision: 5}));
    const eventAudit = await pool?.query(`SELECT
      (SELECT count(*)::int FROM committee_events WHERE committee_id=$1) AS events,
      (SELECT count(*)::int FROM audit_log WHERE committee_id=$1) AS audits`, [created.id]);
    expect(eventAudit?.rows[0]).toEqual(expect.objectContaining({events: expect.any(Number), audits: expect.any(Number)}));
    expect(eventAudit?.rows[0].events).toBeGreaterThan(0);
    expect(eventAudit?.rows[0].audits).toBeGreaterThan(0);
  });

  it('enforces assignment history, invitation hashing, atomic redemption, and final-use concurrency', async () => {
    const owner = await user('seatowner'); const chair = await user('seatchair');
    const first = await user('firstdelegate'); const second = await user('seconddelegate');
    const committee = await stage3.createCommittee(owner, {name: 'Public Committee', visibility: 'PUBLIC'}, context('public'));
    await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('seat-grant'));
    const seat = await stage3.createSeat(chair, committee.id, {stableKey: 'shared', displayName: '共享席位'}, context('shared'));
    const other = await stage3.createSeat(chair, committee.id, {stableKey: 'other', displayName: '其他席位'}, context('other'));
    const assignment = await stage3.assignSeat(chair, committee.id, {seatId: seat.id, userId: first.user.id}, context('assign-first'));
    await stage3.assignSeat(chair, committee.id, {seatId: seat.id, userId: second.user.id}, context('assign-second'));
    await expect(stage3.assignSeat(chair, committee.id, {seatId: other.id, userId: first.user.id}, context('duplicate')))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    await stage3.assignSeat(chair, committee.id, {action: 'END', assignmentId: assignment.id}, context('end'));
    await stage3.assignSeat(chair, committee.id, {seatId: other.id, userId: first.user.id}, context('reassign'));
    const history = await pool?.query('SELECT status FROM seat_assignments WHERE committee_id=$1 AND user_id=$2 ORDER BY assigned_at',
      [committee.id, first.user.id]);
    expect(history?.rows.map(row => row.status)).toEqual(['ENDED', 'ACTIVE']);

    const invitation = await stage3.createInvitation(chair, committee.id, {seatId: seat.id, maxUses: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString()}, context('invitation'));
    const stored = await pool?.query<{code_hash: Buffer}>('SELECT code_hash FROM seat_invitations WHERE id=$1', [invitation.id]);
    expect(stored?.rows[0]?.code_hash).toHaveLength(32);
    expect(stored?.rows[0]?.code_hash.toString('utf8')).not.toContain(invitation.code);
    const third = await user('thirddelegate'); const fourth = await user('fourthdelegate');
    const raced = await Promise.allSettled([
      stage3.redeemInvitation(third, invitation.code, context('redeem-third')),
      stage3.redeemInvitation(fourth, invitation.code, context('redeem-fourth'))
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1);
    const invitationState = await pool?.query('SELECT use_count,max_uses FROM seat_invitations WHERE id=$1', [invitation.id]);
    expect(invitationState?.rows[0]).toEqual({use_count: 1, max_uses: 1});
    const redeemed = await pool?.query(`SELECT count(*)::int AS count FROM committee_memberships m
      JOIN seat_assignments a ON a.committee_id=m.committee_id AND a.user_id=m.user_id
      WHERE m.committee_id=$1 AND a.seat_id=$2 AND a.status='ACTIVE' AND m.status='ACTIVE'`, [committee.id, seat.id]);
    expect(redeemed?.rows[0].count).toBe(2);
    expect(JSON.stringify(await pool?.query('SELECT after_summary FROM audit_log WHERE committee_id=$1', [committee.id])))
      .not.toContain(invitation.code);
    await expect(stage3.redeemInvitation(fourth, 'wrong-invitation-code', context('wrong-code')))
      .rejects.toMatchObject({code: 'LINK_EXPIRED'});
    const revoked = await stage3.createInvitation(chair, committee.id, {seatId: other.id, maxUses: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString()}, context('revoked-invitation'));
    await stage3.revokeInvitation(chair, committee.id, revoked.id, context('revoke-invitation'));
    await expect(stage3.redeemInvitation(fourth, revoked.code, context('redeem-revoked')))
      .rejects.toMatchObject({code: 'LINK_EXPIRED'});
    const expired = await stage3.createInvitation(chair, committee.id, {seatId: other.id, maxUses: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString()}, context('expired-invitation'));
    await pool?.query('UPDATE seat_invitations SET expires_at=now()-interval \'1 minute\' WHERE id=$1', [expired.id]);
    await expect(stage3.redeemInvitation(fourth, expired.code, context('redeem-expired')))
      .rejects.toMatchObject({code: 'LINK_EXPIRED'});
  });

  it('keeps built-ins and published versions immutable and restricts rule management to the correct scope', async () => {
    const owner = await user('ruleowner'); const chair = await user('rulechair');
    const committee = await stage3.createCommittee(owner, {name: 'Rules Committee', visibility: 'PUBLIC'}, context('rules'));
    await stage3.setChair(owner, committee.id, chair.user.id, true, 1, context('rules-grant'));
    const packages = await stage3.listRulePackages();
    expect(packages.filter(item => item.scope === 'BUILTIN')).toHaveLength(2);
    const source = packages.find(item => item.key === 'builtin:quorum-default') as (typeof packages)[number];
    await expect(stage3.createRuleVersion(administrator, source.id, {definition: {}}, context('edit-builtin')))
      .rejects.toMatchObject({code: 'VALIDATION_FAILED'});
    const cloned = await stage3.cloneRulePackage(chair, source.id, {scope: 'COMMITTEE', committeeId: committee.id,
      key: 'committee:rules-test'}, context('clone'));
    expect(cloned).toEqual(expect.objectContaining({scope: 'COMMITTEE', committeeId: committee.id}));
    const version = cloned.versions[0] as {id: string};
    expect(await stage3.validateRuleVersion(chair, version.id)).toEqual({valid: true, issues: []});
    const simulation = await stage3.simulateRuleVersion(chair, version.id, {
      'attendance.allVotingSeatCount': 20, 'attendance.presentVotingSeatCount': 15
    });
    expect(simulation.values['$.attendance.quorum.formula']).toBe(5);
    await expect(stage3.activateRules(owner, committee.id, version.id, 2, context('owner-activate')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage3.activateRules(administrator, committee.id, version.id, 2, context('admin-activate')))
      .rejects.toMatchObject({code: 'FORBIDDEN'});
    const activated = await stage3.activateRules(chair, committee.id, version.id, 2, context('chair-activate'));
    expect(activated.activeRulePackageVersionId).toBe(version.id);
    await expect(stage3.overrideRule(owner, committee.id, {scope: 'ONCE', path: 'ballots.delegateMayChangeVote',
      value: true, operationKey: 'operation-one'}, context('owner-override'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(stage3.overrideRule(administrator, committee.id, {scope: 'ONCE', path: 'ballots.delegateMayChangeVote',
      value: true, operationKey: 'operation-two'}, context('admin-override'))).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(await stage3.overrideRule(chair, committee.id, {scope: 'ONCE', path: 'ballots.delegateMayChangeVote',
      value: true, operationKey: 'operation-three'}, context('chair-override'))).toEqual(expect.objectContaining({scope: 'ONCE'}));
    const future = await stage3.overrideRule(chair, committee.id, {scope: 'FUTURE', path: 'ballots.delegateMayChangeVote',
      value: true}, context('future-override'));
    expect(future.createdVersionId).toBeTruthy();

    const activeDefinition = await pool?.query<{definition: Record<string, unknown>}>('SELECT definition FROM rule_package_versions WHERE id=$1', [version.id]);
    const frozen = freezeRuleEvaluation({packageVersionId: version.id, definition: activeDefinition?.rows[0]?.definition ?? {},
      facts: {'ballot.eligibleSeatCount': 10}, resolvedValues: {threshold: 6}, frozenAt: new Date().toISOString()});
    await expect((pool as pg.Pool).query(`UPDATE rule_package_versions SET definition='{}'::jsonb WHERE id=$1`, [version.id]))
      .rejects.toThrow('published rule versions are immutable');
    expect(frozen.packageVersionId).toBe(version.id);
    expect(frozen.resolvedValues).toEqual({threshold: 6});
  });
});
