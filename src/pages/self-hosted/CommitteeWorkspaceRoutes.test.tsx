import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {SelfHostedUser} from '../../services/self-hosted-identity';
import SelfHostedWorkspace from '../SelfHostedWorkspace';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const user: SelfHostedUser = {id: 'user', email: 'user@example.com', displayName: 'User', status: 'ACTIVE',
  isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null};

function snapshot(audience: CommitteeWorkspaceSnapshot['viewer']['audience']): CommitteeWorkspaceSnapshot {
  return {schemaVersion: 2, committee: {id: 'committee', name: 'Security Council', chairLabel: 'Chair',
    topic: 'Climate security', conference: 'Main Hall', visibility: 'PUBLIC', operationMode: 'DELEGATE_OPERATED',
    status: 'ACTIVE', activeRulePackageVersionId: 'rules', revision: 4}, seats: [{id: 'seat', stableKey: 'china',
    displayName: 'China', rank: 'VETO', canVote: true, hasVeto: true, mustVote: false, sortOrder: 0, active: true,
    revision: 2, flag: {type: 'STANDARD', value: 'cn'}}], viewer: {audience, seatId: audience === 'MEMBER' ? 'seat' : null},
  memberships: audience === 'CHAIR' || audience === 'OWNER' ? [{userId: 'delegate', status: 'ACTIVE'}] : undefined,
  chairs: audience === 'CHAIR' || audience === 'OWNER' ? [{userId: 'chair-user'}] : undefined,
  assignments: audience === 'CHAIR' || audience === 'OWNER'
    ? [{id: 'assignment', seatId: 'seat', userId: 'delegate', status: 'ACTIVE'}] : undefined,
  attendance: [], points: [], notes: [], textPosts: [], activeRules: {versionId: 'rules', activePhaseId: null,
    phases: [{id: 'formal-debate', names: {en: 'Formal debate', 'zh-CN': '正式辩论'}}],
    attendanceResponses: ['PRESENT', 'ABSENT'], pointTypes: [], motionTypes: [], speakerLists: [],
    ballots: {delegateMayChangeVote: false, chairMayCorrectVote: true, anonymousStrawpoll: false,
      mustCollectAllVotesWhenVetoSeatEligible: true}, documents: {amendmentsPublicByDefault: false}},
  sync: {committeeEventSequence: 1}};
}

let root: Root | undefined; let container: HTMLDivElement | undefined;
afterEach(() => {if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined;});

async function render(audience: CommitteeWorkspaceSnapshot['viewer']['audience'], path: string,
  currentUser: SelfHostedUser = user,
  customize: (value: CommitteeWorkspaceSnapshot) => CommitteeWorkspaceSnapshot = value => value) {
  const api = {snapshot: vi.fn(async () => customize(snapshot(audience))), openCommitteeEvents: vi.fn(() => () => undefined),
    committeeExportUrl: vi.fn(() => '/api/v1/committees/committee/export'), listRulePackages: vi.fn(async () => [])} as unknown as SelfHostedApi;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {root?.render(<MemoryRouter initialEntries={[path]}><SelfHostedWorkspace user={currentUser}
    logout={() => undefined} api={api} /></MemoryRouter>); await Promise.resolve(); await Promise.resolve();});
  return container;
}

describe('committee workspace routes and roles', () => {
  it('keeps the overview focused on committee and meeting status', async () => {
    const page = await render('OWNER', '/committees/committee');
    expect(page.textContent).toContain('Climate security');
    expect(page.textContent).toContain('Main Hall');
    expect(page.textContent).toContain('ACTIVE');
    expect(page.textContent).toContain('Share committee');
    expect(page.textContent).not.toContain('Create seat');
    expect(page.textContent).not.toContain('Grant Chair');
  });

  it('lets Chairs manage seats, assignments, and one-time invitations from setup', async () => {
    const page = await render('CHAIR', '/committees/committee/setup');
    expect(page.textContent).toContain('Create seat');
    expect(page.textContent).toContain('Assign seat');
    expect(page.textContent).toContain('Create invitation');
    expect(page.textContent).not.toContain('Grant Chair');
  });

  it('lets only Owners manage Chairs', async () => {
    const page = await render('OWNER', '/committees/committee/setup');
    expect(page.textContent).toContain('Grant Chair');
    expect(page.textContent).toContain('Revoke Chair');
  });

  it('does not turn a system administrator into a Committee Chair', async () => {
    const page = await render('PUBLIC', '/committees/committee/setup', {...user, isSystemAdmin: true});
    expect(page.textContent).toContain('China');
    expect(page.textContent).not.toContain('Create seat');
    expect(page.textContent).not.toContain('Assign seat');
    expect(page.textContent).not.toContain('Create invitation');
    expect(page.textContent).not.toContain('Grant Chair');
  });

  it('starts a meeting from a rule-driven phase instead of a stable ID field', async () => {
    const page = await render('CHAIR', '/committees/committee/roll-call');
    expect(page.textContent).toContain('Meeting phase');
    expect(page.textContent).toContain('Formal debate');
    expect(page.textContent).toContain('Start meeting');
  });

  it('shows the dedicated note editor without prompt-based editing', async () => {
    const page = await render('MEMBER', '/committees/committee/notes', user, value => ({...value, notes: [{id: 'note',
      title: 'Strategy', content: 'Coordinate amendments.', sortOrder: 0, revision: 2, createdByUserId: 'user',
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z', deletedAt: null}]}));
    expect(page.textContent).toContain('Strategy');
    expect(page.textContent).toContain('Save note');
    expect(page.querySelector('textarea')?.value).toBe('Coordinate amendments.');
  });

  it('gives Chairs a ruling and attendance form for a pending personal privilege point', async () => {
    const page = await render('CHAIR', '/committees/committee/points', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      points: [{id: 'point', committeeId: 'committee', meetingSessionId: 'meeting',
        pointTypeId: 'point-of-personal-privilege', content: 'The room is too warm.', raisedBySeatId: 'seat',
        raisedBySeatDisplayName: 'China', actorUserId: 'delegate', onBehalfOfSeatId: 'seat', interruptRequested: true,
        status: 'PENDING', chairResponse: '', resolvedByUserId: null, rulePackageVersionId: 'rules', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', resolvedAt: null}],
      activeRules: {...value.activeRules, pointTypes: [{id: 'point-of-personal-privilege',
        names: {en: 'Point of personal privilege', 'zh-CN': '个人特权问题'}, interruptRequested: true}]}}));
    expect(page.textContent).toContain('Ruling');
    expect(page.textContent).toContain('Attendance change');
    expect(page.textContent).toContain('Save ruling');
  });

  it('uses rule-package motion choices and does not render the former combined workspace', async () => {
    const page = await render('MEMBER', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-moderated-caucus',
        names: {en: 'Open a moderated caucus', 'zh-CN': '开启有主持核心磋商'}, procedural: true, requiredSecondCount: 1}]}}));
    expect(page.textContent).toContain('Motion type');
    expect(page.textContent).toContain('Open a moderated caucus');
    expect(page.textContent).not.toContain('stable ID');
    const workspace = page.querySelector('.committee-workspace-page');
    expect(workspace?.textContent).not.toContain('Create strawpoll');
    expect(workspace?.textContent).not.toContain('Create draft resolution');
  });

  it('shows current, next, timers, and queue only for the selected speaker list route', async () => {
    const page = await render('CHAIR', '/committees/committee/caucuses/list', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL', status: 'OPEN',
        topic: '', defaultSpeechMs: 60_000, rulePackageVersionId: 'rules', currentEntryId: 'current', speechTimerId: 'speech-timer',
        totalTimerId: null, revision: 2, queue: [{id: 'current', seatId: 'seat', seatDisplayName: 'China', position: 1,
          status: 'CURRENT', createdAt: '2026-08-14T00:00:00.000Z'}, {id: 'next', seatId: 'france', seatDisplayName: 'France',
          position: 2, status: 'QUEUED', createdAt: '2026-08-14T00:00:00.000Z'}], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST', ownerId: 'list', running: false,
        startedAt: null, remainingAtStartMs: 60_000, remainingMs: 60_000, revision: 1, expiredAt: null,
        serverTime: '2026-08-14T00:00:00.000Z'}]}));
    expect(page.textContent).toContain('Current speaker');
    expect(page.textContent).toContain('Next speaker');
    expect(page.textContent).toContain('China');
    expect(page.textContent).toContain('France');
    expect(page.textContent).not.toContain('Motion type');
  });

  it('keeps the four resolution tabs on the selected document route', async () => {
    const page = await render('PUBLIC', '/committees/committee/resolutions/resolution/body', user, value => ({...value,
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION', resolutionId: null,
        title: 'Climate resolution', status: 'PUBLISHED', rulePackageVersionId: 'rules', currentVersion: {id: 'version',
          versionNumber: 1, content: 'Operative text', createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
        public: true, revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}]}));
    expect(page.textContent).toContain('Activity');
    expect(page.textContent).toContain('Body');
    expect(page.textContent).toContain('Amendments');
    expect(page.textContent).toContain('Ballot');
    expect(page.textContent).toContain('Operative text');
  });

  it('keeps storage inside the account-authorized resource tabs', async () => {
    const memberPage = await render('MEMBER', '/committees/committee/posts');
    expect(memberPage.textContent).toContain('Text resources');
    expect(memberPage.textContent).toContain('Attachments');
    expect(memberPage.querySelector('.committee-workspace-page')?.textContent).not.toContain('Storage');
    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const chairPage = await render('CHAIR', '/committees/committee/posts');
    expect(chairPage.querySelector('.committee-workspace-page')?.textContent).toContain('Storage');
  });

  it('separates Chair operation controls from Owner lifecycle controls', async () => {
    const chairPage = await render('CHAIR', '/committees/committee/settings');
    expect(chairPage.textContent).toContain('Operation mode');
    expect(chairPage.textContent).toContain('Pause committee');
    expect(chairPage.textContent).not.toContain('Archive committee');
    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const ownerPage = await render('OWNER', '/committees/committee/settings');
    expect(ownerPage.textContent).toContain('Archive committee');
  });

  it('computes only snapshot-backed per-seat statistics', async () => {
    const page = await render('PUBLIC', '/committees/committee/stats', user, value => ({...value,
      motions: [{id: 'motion', committeeId: 'committee', meetingSessionId: 'meeting', motionTypeId: 'motion',
        proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China', parameters: {}, status: 'PASSED',
        rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {},
          resolvedValues: {}, frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 0,
        seconds: [], revision: 1, createdAt: '2026-08-14T00:00:00.000Z', decidedAt: '2026-08-14T00:00:00.000Z'}]}));
    const stats = page.querySelector('.committee-workspace-page')?.textContent ?? '';
    expect(stats).toContain('Speeches');
    expect(stats).toContain('Motions');
    expect(stats).toContain('Document discussion entries');
    expect(stats).toContain('China');
  });
});
