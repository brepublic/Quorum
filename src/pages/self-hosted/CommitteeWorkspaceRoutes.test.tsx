import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteePoint, CommitteeWorkspaceSnapshot, CreatedStrawpoll, ProceedingDocument, ProceedingMotion, RollCall,
  SpeakerList, Strawpoll} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {SelfHostedUser} from '../../services/self-hosted-identity';
import SelfHostedWorkspace from '../SelfHostedWorkspace';
import {generalQueueHasDividerBefore, legacyInterlacedQueue} from './ProceedingsPanel';

vi.mock('../../services/sha256', () => ({sha256File: vi.fn(async () => 'a'.repeat(64))}));

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const user: SelfHostedUser = {id: 'user', email: 'user@example.com', displayName: 'User', status: 'ACTIVE',
  isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null};

function snapshot(audience: CommitteeWorkspaceSnapshot['viewer']['audience']): CommitteeWorkspaceSnapshot {
  return {schemaVersion: 2, ...(audience === 'CHAIR' || audience === 'OWNER' ? {countryTemplate: {
    id: 'builtin:default', key: 'builtin:default', builtin: true, names: {en: 'Default countries'}, defaultLanguage: 'en',
    countryLanguages: ['en'], revision: 1, createdAt: null, updatedAt: null, countries: [{id: 'country-france',
      stableKey: 'france', names: {en: 'France'}, defaultLanguage: 'en', continent: null, sortOrder: 1,
      flag: {type: 'STANDARD', value: 'fr'}, revision: 1}]}} : {}), committee: {id: 'committee', name: 'Security Council', chairLabel: 'Chair',
    topic: 'Climate security', conference: 'Main Hall', visibility: 'PUBLIC', operationMode: 'DELEGATE_OPERATED',
    status: 'ACTIVE', activeRulePackageVersionId: 'rules', revision: 4}, seats: [{id: 'seat', stableKey: 'china',
    displayName: 'China', rank: 'VETO', canVote: true, hasVeto: true, mustVote: false, sortOrder: 0, active: true,
    revision: 2, flag: {type: 'STANDARD', value: 'cn'}}], viewer: {audience, seatId: audience === 'MEMBER' ? 'seat' : null},
  motionSettings: {delegateMotionProposalsEnabled: false, delegateMotionVotingEnabled: false},
  layoutSettings: {moveQueueUp: false, timersInSeparateColumns: false},
  memberships: audience === 'CHAIR' || audience === 'OWNER' ? [{userEmail: 'delegate@example.com', status: 'ACTIVE'}] : undefined,
  chairs: audience === 'CHAIR' || audience === 'OWNER' ? [{userEmail: 'chair@example.com'}] : undefined,
  assignments: audience === 'CHAIR' || audience === 'OWNER'
    ? [{id: 'assignment', seatId: 'seat', userEmail: 'delegate@example.com', status: 'ACTIVE'}] : undefined,
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
  customize: (value: CommitteeWorkspaceSnapshot) => CommitteeWorkspaceSnapshot = value => value,
  apiOverrides: Partial<SelfHostedApi> = {}) {
  const api = {snapshot: vi.fn(async () => customize(snapshot(audience))), openCommitteeEvents: vi.fn(() => () => undefined),
    committeeExportUrl: vi.fn(() => '/api/v1/committees/committee/export'), listRulePackages: vi.fn(async () => []),
    fileDownloadUrl: vi.fn((fileId: string) => `/api/v1/files/${fileId}/download`),
    ...apiOverrides} as unknown as SelfHostedApi;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {root?.render(<MemoryRouter initialEntries={[path]}><SelfHostedWorkspace user={currentUser}
    logout={() => undefined} api={api} /></MemoryRouter>); await Promise.resolve(); await Promise.resolve();});
  return container;
}

function clickSemanticCheckbox(element?: Element | null) {
  for (const type of ['mousedown', 'mouseup', 'click']) element?.dispatchEvent(new MouseEvent(type, {bubbles: true}));
}

describe('committee workspace routes and roles', () => {
  it('lets each committee page own its layout inside a full-width workspace shell', async () => {
    const page = await render('OWNER', '/committees/committee/roll-call');
    const workspace = page.querySelector('.committee-workspace-page');

    expect(workspace?.classList.contains('fluid')).toBe(true);
    expect(workspace?.querySelector(':scope > .ui.segment')).toBeNull();
    expect(workspace?.textContent).toContain('Start meeting');
  });

  it('opens a committee on roll call and keeps information in a centered card', async () => {
    const defaultPage = await render('OWNER', '/committees/committee');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(defaultPage.textContent).toContain('Start meeting');

    const page = await render('OWNER', '/committees/committee/info');
    expect(page.querySelector('.committee-overview-page > .committee-overview-card')).toBeTruthy();
    expect(page.textContent).toContain('Climate security');
    expect(page.textContent).toContain('Main Hall');
    expect(page.textContent).toContain('ACTIVE');
    expect(page.textContent).toContain('Share committee');
    expect(page.textContent).not.toContain('Create seat');
    expect(page.textContent).not.toContain('Grant Chair');
  });

  it('lets Chairs manage seats, assignments, and one-time invitations from setup', async () => {
    const page = await render('CHAIR', '/committees/committee/setup');
    expect(page.querySelector('[aria-label="Create seat"]')).toBeTruthy();
    expect(page.querySelector('[aria-label="Seat name"]')).toBeNull();
    expect(page.textContent).toContain('France');
    expect(page.textContent).toContain('Must Vote');
    expect(page.querySelector('.committee-setup-page > .ui.grid')).toBeTruthy();
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

  it('starts a meeting without exposing the internal default phase', async () => {
    const page = await render('CHAIR', '/committees/committee/roll-call');
    expect(page.textContent).not.toContain('Formal debate');
    expect(page.textContent).toContain('Start meeting');
  });

  it('restores the paged roll-call board and lets a Chair directly change any frozen seat', async () => {
    const setRollCallResponse = vi.fn(async (): Promise<RollCall> => ({id: 'roll-call', committeeId: 'committee',
      meetingSessionId: 'meeting', status: 'IN_PROGRESS', currentSeatId: 'seat-0', rulePackageVersionId: 'rules',
      allowedResponses: ['PRESENT', 'PRESENT_AND_VOTING', 'ABSENT'], entries: [], revision: 4,
      startedAt: '2026-08-14T00:00:00.000Z', completedAt: null}));
    const seats = Array.from({length: 20}, (_, index) => ({id: `seat-${index}`, stableKey: `seat-${index}`,
      displayName: `Seat ${String(20 - index).padStart(2, '0')}`, rank: 'STANDARD' as const, canVote: true,
      hasVeto: false, mustVote: false, sortOrder: index, active: true, revision: 1,
      flag: {type: 'EMOJI' as const, value: index === 0 ? '🏳️' : '🌐'}}));
    const page = await render('CHAIR', '/committees/committee/roll-call', user, value => ({...value, seats,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      rollCall: {id: 'roll-call', committeeId: 'committee', meetingSessionId: 'meeting', status: 'IN_PROGRESS',
        currentSeatId: 'seat-0', rulePackageVersionId: 'rules', allowedResponses: ['PRESENT', 'PRESENT_AND_VOTING', 'ABSENT'],
        entries: [{id: 'entry', seatId: 'seat-1', seatDisplayName: 'Seat 02', response: 'PRESENT', actorUserId: 'chair',
          onBehalfOfSeatId: 'seat-1', rulePackageVersionId: 'rules', recordedAt: '2026-08-14T00:00:00.000Z', revision: 1}],
        revision: 3, startedAt: '2026-08-14T00:00:00.000Z', completedAt: null}}), {setRollCallResponse});

    expect(page.querySelectorAll('.roll-call-grid .roll-call-member')).toHaveLength(18);
    expect(page.querySelector<HTMLButtonElement>('.roll-call-grid .roll-call-member')?.dataset.rollCallSeat).toBe('seat-0');
    expect(Array.from(page.querySelectorAll<HTMLButtonElement>('.roll-call-grid .roll-call-member'))
      .slice(0, 6).map(seat => seat.dataset.rollCallSeat)).toEqual(['seat-0', 'seat-6', 'seat-12', 'seat-1', 'seat-7', 'seat-13']);
    expect(page.textContent).toContain('1 of 20 called');
    expect(page.textContent).toContain('Present and voting');
    const secondSeat = page.querySelector<HTMLButtonElement>('[data-roll-call-seat="seat-1"]');
    await act(async () => {secondSeat?.click(); await Promise.resolve();});
    expect(setRollCallResponse).toHaveBeenCalledWith('roll-call', 3, 'seat-1', 'ABSENT');
  });

  it('keeps general-list dividers anchored to three-person slots as speakers advance and the queue reorders', () => {
    const dividerIndexes = (precedingCount: number, length: number) => Array.from({length}, (_, index) => index)
      .filter(index => generalQueueHasDividerBefore(index, precedingCount));
    expect(dividerIndexes(0, 9)).toEqual([3, 6]);
    expect(dividerIndexes(1, 8)).toEqual([2, 5]);
    expect(dividerIndexes(2, 7)).toEqual([1, 4]);
    expect(dividerIndexes(3, 6)).toEqual([0, 3]);
    const reordered = ['B', 'H', 'D', 'E', 'F', 'G', 'C', 'I'];
    const boundaries = dividerIndexes(1, reordered.length);
    expect([reordered.slice(0, boundaries[0]), reordered.slice(boundaries[0], boundaries[1]),
      reordered.slice(boundaries[1])]).toEqual([['B', 'H'], ['D', 'E', 'F'], ['G', 'C', 'I']]);
  });

  it('keeps legacy interlacing order and drops absent queued seats', () => {
    const entry = (id: string, seatId: string, stance: 'FOR' | 'AGAINST' | 'NEUTRAL', position: number) => ({
      id, seatId, seatDisplayName: seatId, position, status: 'QUEUED' as const, stance, speechDurationMs: 60_000,
      createdAt: '2026-08-14T00:00:00.000Z'
    });
    const result = legacyInterlacedQueue([
      entry('for-1', 'present-for', 'FOR', 1),
      entry('absent', 'absent', 'AGAINST', 2),
      entry('against-1', 'present-against', 'AGAINST', 3),
      entry('neutral-1', 'present-neutral', 'NEUTRAL', 4),
      entry('for-2', 'present-for-2', 'FOR', 5)
    ], new Set(['present-for', 'present-against', 'present-neutral', 'present-for-2']));
    expect(result.map(item => item.id)).toEqual(['for-1', 'against-1', 'neutral-1', 'for-2']);
  });

  it('shows the dedicated note editor without prompt-based editing', async () => {
    const updateNote = vi.fn(async () => ({id: 'note', title: 'Strategy', content: 'Coordinate amendments soon.',
      sortOrder: 0, revision: 3, createdByUserId: 'user', createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:01.000Z', deletedAt: null}));
    const page = await render('MEMBER', '/committees/committee/notes', user, value => ({...value, notes: [{id: 'note',
      title: 'Strategy', content: 'Coordinate amendments.', sortOrder: 0, revision: 2, createdByUserId: 'user',
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z', deletedAt: null}]}), {updateNote});
    expect(page.textContent).toContain('Strategy');
    expect(page.textContent).not.toContain('Save note');
    const textarea = page.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Coordinate amendments.');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Coordinate amendments soon.');
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 650));
    });
    expect(updateNote).toHaveBeenCalledWith('note', 2,
      {title: 'Strategy', content: 'Coordinate amendments soon.'});
  });

  it('saves a dirty note before switching instead of dropping the draft', async () => {
    const notes = [{id: 'first', title: 'First', content: 'Draft one', sortOrder: 0, revision: 1,
      createdByUserId: 'user', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z', deletedAt: null},
    {id: 'second', title: 'Second', content: 'Draft two', sortOrder: 1, revision: 1,
      createdByUserId: 'user', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z', deletedAt: null}];
    const updateNote = vi.fn(async () => ({...notes[0], content: 'Changed before switching', revision: 2}));
    const page = await render('MEMBER', '/committees/committee/notes', user, value => ({...value, notes}), {updateNote});
    const textarea = page.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Changed before switching');
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
    });
    const second = [...page.querySelectorAll<HTMLElement>('[aria-label="Note list"] .item')]
      .find(item => item.textContent?.trim() === 'Second');
    await act(async () => {second?.click(); await Promise.resolve(); await Promise.resolve();});
    expect(updateNote).toHaveBeenCalledWith('first', 1, {title: 'First', content: 'Changed before switching'});
    expect((page.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Draft two');
  });

  it('gives Chairs a ruling and attendance form for a pending personal privilege point', async () => {
    const page = await render('CHAIR', '/committees/committee/points', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
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

  it('guides users to roll call when no meeting is open', async () => {
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第2会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'PENDING', revision: 2,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}));

    expect(page.textContent).toContain('Open a meeting first.');
    expect(page.querySelector('.motions-empty-card')).not.toBeNull();
    expect(page.querySelector('.motions-empty-card a[href="/committees/committee/roll-call"]')?.textContent).toContain('Roll call ->');
  });

  it('shows the ended-session state immediately after passing a suspension motion', async () => {
    let sessionEnded = false;
    const motion: ProceedingMotion = {id: 'suspend', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'suspend-meeting', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China', parameters: {},
      status: 'SECONDED', rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules',
        definition: {}, facts: {}, resolvedValues: {}, frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 0,
      seconds: [], revision: 1, directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1,
        eligibility: [], choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []},
      createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null, destinationPath: null};
    const decideMotion = vi.fn(async () => {
      sessionEnded = true;
      return {...motion, status: 'PASSED' as const, decidedAt: '2026-08-14T00:01:00.000Z'};
    });
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      committee: {...value.committee, operationMode: 'CHAIR_OPERATED'},
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: sessionEnded ? 'PENDING' : 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}, motions: [motion],
      activeRules: {...value.activeRules, motionTypes: [{id: 'suspend-meeting', names: {en: 'Suspend meeting'},
        procedural: true, requiredSecondCount: 0}]}}), {decideMotion});

    const passed = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Passed');
    await act(async () => {passed?.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();});
    expect(decideMotion).toHaveBeenCalledWith('suspend', 1, 'PASSED');
    expect(page.textContent).toContain('Current meeting session has ended.');
    expect(page.querySelector('.motions-empty-card a[href="/committees/committee/roll-call"]')?.textContent).toContain('Roll call ->');
  });

  it('separates motion history at meeting-session boundaries', async () => {
    const sessions: NonNullable<CommitteeWorkspaceSnapshot['meetingSessions']> = [
      {id: 'session-2', committeeId: 'committee', name: '第2会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 2, createdAt: '2026-08-14T01:00:00.000Z', closedAt: null},
      {id: 'session-1', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'CLOSED', revision: 2, createdAt: '2026-08-14T00:00:00.000Z',
        closedAt: '2026-08-14T00:30:00.000Z'}
    ];
    const motion = (id: string, meetingSessionId: string, createdAt: string): ProceedingMotion => ({id, committeeId: 'committee',
      meetingSessionId, motionTypeId: 'suspend-meeting', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
      parameters: {}, status: 'PASSED', rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1,
        packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {}, frozenAt: createdAt}, requiredSecondCount: 0,
      seconds: [], revision: 1, directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1,
        eligibility: [], choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []}, createdAt,
      decidedAt: null, destinationPath: null});
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: sessions[0], meetingSessions: sessions, motions: [
        motion('older', 'session-1', '2026-08-14T00:10:00.000Z')],
      activeRules: {...value.activeRules, motionTypes: [{id: 'suspend-meeting', names: {en: 'Suspend meeting'},
        procedural: true, requiredSecondCount: 0}]}}));

    expect(page.querySelectorAll('.history-session-divider')).toHaveLength(2);
    expect(page.querySelectorAll('.history-session-divider')[0]?.textContent).toContain('第2会期');
    expect(page.querySelectorAll('.history-session-divider')[1]?.textContent).toContain('第1会期');
    expect(page.querySelectorAll('.motion-queue')).toHaveLength(1);
    expect(page.querySelector('.current-session-empty')?.textContent).toContain('(No motions)');
  });

  it('separates point history at meeting-session boundaries', async () => {
    const sessions: NonNullable<CommitteeWorkspaceSnapshot['meetingSessions']> = [
      {id: 'session-2', committeeId: 'committee', name: '第2会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 2, createdAt: '2026-08-14T01:00:00.000Z', closedAt: null},
      {id: 'session-1', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'CLOSED', revision: 2, createdAt: '2026-08-14T00:00:00.000Z',
        closedAt: '2026-08-14T00:30:00.000Z'}
    ];
    const point = (id: string, meetingSessionId: string, createdAt: string): CommitteePoint => ({id, committeeId: 'committee',
      meetingSessionId, pointTypeId: 'point-of-order', content: 'Order', raisedBySeatId: 'seat',
      raisedBySeatDisplayName: 'China', actorUserId: 'user', onBehalfOfSeatId: 'seat', interruptRequested: false,
      status: 'UPHELD', chairResponse: '', resolvedByUserId: 'user', rulePackageVersionId: 'rules', revision: 1,
      createdAt, resolvedAt: createdAt});
    const page = await render('CHAIR', '/committees/committee/points', user, value => ({...value,
      meetingSession: sessions[0], meetingSessions: sessions, points: [
        point('older', 'session-1', '2026-08-14T00:10:00.000Z')],
      activeRules: {...value.activeRules, pointTypes: [{id: 'point-of-order', names: {en: 'Point of order'},
        interruptRequested: false}]}}));

    expect(page.querySelectorAll('.history-session-divider')).toHaveLength(2);
    expect(page.querySelectorAll('.history-session-divider')[0]?.textContent).toContain('第2会期');
    expect(page.querySelectorAll('.history-session-divider')[1]?.textContent).toContain('第1会期');
    expect(page.querySelectorAll('.point-list')).toHaveLength(1);
  });

  it('uses rule-package motion choices and does not render the former combined workspace', async () => {
    const page = await render('MEMBER', '/committees/committee/motions', user, value => ({...value,
      motionSettings: {...value.motionSettings, delegateMotionProposalsEnabled: true},
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-moderated-caucus',
        names: {en: 'Open a moderated caucus', 'zh-CN': '开启有主持核心磋商'}, procedural: true, requiredSecondCount: 1}]}}));
    expect(page.textContent).toContain('Type');
    expect(page.textContent).toContain('Open a moderated caucus');
    expect(page.textContent).not.toContain('stable ID');
    const workspace = page.querySelector('.committee-workspace-page');
    expect(workspace?.textContent).not.toContain('Create strawpoll');
    expect(workspace?.textContent).not.toContain('Create draft resolution');
  });

  it('targets an existing unintroduced draft instead of naming a new resolution in the introduction motion', async () => {
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION',
        resolutionId: null, title: 'New draft resolution 1', status: 'DRAFT', rulePackageVersionId: 'rules',
        currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'},
        votingVersionId: null, public: false, proposerSeatId: null, seconderSeatId: null, delegatesCanAmend: false,
        directVote: null, resultDecisions: [], revision: 1, discussion: [],
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}],
      activeRules: {...value.activeRules, motionTypes: [{id: 'introduce-draft-resolution',
        names: {en: 'Introduce draft resolution', 'zh-CN': '展示决议草案'}, procedural: true,
        requiredSecondCount: 1}]}}));
    expect(page.textContent).toContain('Target resolution');
    expect(page.textContent).toContain('New draft resolution 1');
    expect(page.textContent).not.toContain('Name');
  });

  it('targets an existing amendment draft instead of creating one from the introduction motion', async () => {
    const baseDocument = {committeeId: 'committee', meetingSessionId: 'meeting', rulePackageVersionId: 'rules',
      votingVersionId: null, public: false, proposerSeatId: 'seat', seconderSeatId: null, delegatesCanAmend: false,
      directVote: null, resultDecisions: [], revision: 1, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [
        {...baseDocument, id: 'resolution', kind: 'RESOLUTION', resolutionId: null, title: 'New draft resolution 1',
          status: 'PUBLISHED', public: true, currentVersion: {id: 'resolution-version', versionNumber: 1,
            content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}},
        {...baseDocument, id: 'amendment', kind: 'AMENDMENT', resolutionId: 'resolution', title: 'New amendment 1',
          status: 'DRAFT', currentVersion: {id: 'amendment-version', versionNumber: 1,
            content: 'Replace clause 1', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}}
      ] as ProceedingDocument[],
      activeRules: {...value.activeRules, motionTypes: [{id: 'introduce-amendment',
        names: {en: 'Introduce amendment', 'zh-CN': '展示修正案'}, procedural: true, requiredSecondCount: 1}]}}));
    expect(page.textContent).toContain('Target amendment');
    expect(page.textContent).toContain('New amendment 1');
    expect(page.textContent).not.toContain('Target resolution');
  });

  it('targets an introduced amendment from the formal-vote motion', async () => {
    const document = {committeeId: 'committee', meetingSessionId: 'meeting', rulePackageVersionId: 'rules',
      votingVersionId: null, public: true, proposerSeatId: 'seat', seconderSeatId: null, delegatesCanAmend: false,
      directVote: null, resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{...document, id: 'amendment', kind: 'AMENDMENT', resolutionId: 'resolution',
        title: 'New amendment 1', status: 'PUBLISHED', currentVersion: {id: 'amendment-version', versionNumber: 1,
          content: 'Replace clause 1', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}}] as ProceedingDocument[],
      activeRules: {...value.activeRules, motionTypes: [{id: 'vote-on-amendment',
        names: {en: 'Vote on amendment', 'zh-CN': '对修正案投票'}, procedural: false, requiredSecondCount: 0}]}}));
    expect(page.textContent).toContain('Target amendment');
    expect(page.textContent).toContain('New amendment 1');
    expect(page.textContent).not.toContain('Text');
  });

  it('offers the old resolution caucus action as a motion and fills its topic', async () => {
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      seats: [...value.seats, {id: 'seconder', stableKey: 'usa', displayName: 'United States', rank: 'STANDARD',
        canVote: true, hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1,
        flag: {type: 'STANDARD', value: 'us'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance-1',
        updatedAt: '2026-08-14T00:00:00.000Z'}, {seatId: 'seconder', state: 'PRESENT',
        lastEventId: 'attendance-2', updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION',
        resolutionId: null, title: 'New draft resolution 1', status: 'PUBLISHED', rulePackageVersionId: 'rules',
        currentVersion: {id: 'version', versionNumber: 1, content: 'Draft body', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: true,
        proposerSeatId: 'seat', seconderSeatId: 'seconder', delegatesCanAmend: false, directVote: null,
        resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-moderated-caucus',
        names: {en: 'Open a moderated caucus', 'zh-CN': '开启有主持核心磋商'}, procedural: true,
        requiredSecondCount: 1}]}}));

    expect(page.textContent).toContain('Moderated caucus - New draft resolution 1');
    const option = [...page.querySelectorAll<HTMLElement>('.motion-proposal-form .menu .item')]
      .find(item => item.textContent?.includes('Moderated caucus - New draft resolution 1'));
    await act(async () => {option?.click(); await Promise.resolve();});
    expect(page.querySelector<HTMLInputElement>('.motion-proposal-form input[placeholder="Topic"]')?.value)
      .toBe('New draft resolution 1');
  });

  it('restores the focused legacy motion form and pending-card removal', async () => {
    const proposed: ProceedingMotion = {id: 'motion', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'open-unmoderated-caucus', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
      parameters: {caucusDuration: 10, caucusUnit: 'min'}, status: 'SECONDED', rulePackageVersionId: 'rules',
      ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {},
        frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 0, seconds: [], revision: 1,
      directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1, eligibility: [],
        choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []},
      createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null, destinationPath: null};
    const proposeMotion = vi.fn(async (): Promise<ProceedingMotion> => proposed);
    const withdrawMotion = vi.fn(async (): Promise<ProceedingMotion> => ({...proposed, status: 'WITHDRAWN', revision: 2,
      decidedAt: '2026-08-14T00:01:00.000Z'}));
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance', updatedAt: '2026-08-14T00:00:00.000Z'}],
      motions: [proposed],
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-unmoderated-caucus',
        names: {en: 'Open an unmoderated caucus', 'zh-CN': '开启自由磋商'}, procedural: true,
        requiredSecondCount: 0}]}}), {proposeMotion, withdrawMotion});

    const form = page.querySelector<HTMLFormElement>('.motion-proposal-form');
    expect(form).not.toBeNull();
    expect(page.querySelector('.motions-page')).not.toBeNull();
    expect(page.textContent).toContain('Proposer');
    expect(page.textContent).toContain('Duration');
    expect(page.textContent).not.toContain('Sorted from most to least disruptive.');
    expect(proposeMotion).not.toHaveBeenCalled();
    const withdraw = page.querySelector<HTMLButtonElement>('button[aria-label="Delete"]');
    expect(withdraw).not.toBeNull();
    await act(async () => {withdraw?.click(); await Promise.resolve();});
    expect(withdrawMotion).toHaveBeenCalledWith('motion', 1);
  });

  it('shows read-only counts and the non-voting-seat setting in delegate-operated motion cards', async () => {
    const motion: ProceedingMotion = {id: 'motion', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'open-unmoderated-caucus', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
      parameters: {caucusDuration: 10, caucusUnit: 'min'}, status: 'SECONDED', rulePackageVersionId: 'rules',
      ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {},
        frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 0, seconds: [], revision: 1,
      directVote: {includeNonVotingSeats: true, startedAt: null, settingsRevision: 1,
        eligibility: [{seatId: 'seat', seatDisplayName: 'China'}, {seatId: 'observer', seatDisplayName: 'Observer'}],
        choices: ['FOR', 'AGAINST'], threshold: 2,
        automaticResult: null, votes: []}, createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null,
      destinationPath: null};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      seats: [...value.seats, {id: 'observer', stableKey: 'observer', displayName: 'Observer', rank: 'OBSERVER',
        canVote: false, hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1,
        flag: {type: 'EMOJI', value: '🌐'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance-1',
        updatedAt: '2026-08-14T00:00:00.000Z'}, {seatId: 'observer', state: 'PRESENT',
        lastEventId: 'attendance-2', updatedAt: '2026-08-14T00:00:00.000Z'}], motions: [motion],
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-unmoderated-caucus',
        names: {en: 'Open an unmoderated caucus', 'zh-CN': '开启自由磋商'}, procedural: true,
        requiredSecondCount: 0}]}}));

    expect(page.querySelector<HTMLInputElement>('.motion .ui.toggle.checkbox input')?.checked).toBe(true);
    const counts = [...page.querySelectorAll<HTMLButtonElement>('.motion-vote-panel button')];
    expect(counts).toHaveLength(2);
    expect(counts.every(button => button.disabled)).toBe(true);
    expect(counts.map(button => button.textContent?.trim())).toEqual(['0', '0']);
    expect(page.querySelector('.motion > .buttons')).toBeNull();
  });

  it('opens a formal motion ballot only in delegate-operated mode', async () => {
    const createBallot = vi.fn(async () => ({} as never));
    const motion: ProceedingMotion = {id: 'motion', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'introduce-draft-resolution', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
      parameters: {resolutionTarget: 'resolution'}, status: 'SECONDED', rulePackageVersionId: 'rules',
      ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {},
        resolvedValues: {procedural: false}, frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 1,
      seconds: [{id: 'second', seatId: 'seconder', seatDisplayName: 'United States',
        createdAt: '2026-08-14T00:00:00.000Z'}], revision: 2,
      directVote: {includeNonVotingSeats: true, startedAt: null, settingsRevision: 1, eligibility: [],
        choices: ['FOR', 'AGAINST', 'ABSTAIN'], threshold: 1, automaticResult: null, votes: []},
      createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null, destinationPath: null};
    const customize = (value: CommitteeWorkspaceSnapshot) => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN' as const, revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}, motions: [motion],
      activeRules: {...value.activeRules, motionTypes: [{id: 'introduce-draft-resolution',
        names: {en: 'Introduce draft resolution', 'zh-CN': '展示决议草案'}, procedural: false,
        requiredSecondCount: 1}]}});
    const page = await render('CHAIR', '/committees/committee/motions', user, customize, {createBallot});
    const open = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Open substantive ballot');
    await act(async () => {open?.click(); await Promise.resolve();});
    expect(createBallot).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', subjectType: 'MOTION',
      subjectId: 'motion', procedural: false, thresholdKind: 'SIMPLE_MAJORITY'});

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const chairOperatedPage = await render('CHAIR', '/committees/committee/motions', user, value => ({...customize(value),
      committee: {...value.committee, operationMode: 'CHAIR_OPERATED'}}));
    expect([...chairOperatedPage.querySelectorAll<HTMLButtonElement>('button')]
      .some(button => button.textContent?.trim() === 'Open substantive ballot')).toBe(false);
    expect([...chairOperatedPage.querySelectorAll<HTMLButtonElement>('.motion > .buttons button')]
      .map(button => button.textContent?.trim())).toEqual(['Failed', 'Passed']);
  });

  it('expands an open motion ballot and lets the Chair stop voting', async () => {
    const closeBallot = vi.fn(async () => ({} as never));
    const motion: ProceedingMotion = {id: 'motion', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'introduce-draft-resolution', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
      parameters: {resolutionTarget: 'resolution'}, status: 'VOTING', rulePackageVersionId: 'rules',
      ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {},
        resolvedValues: {procedural: false}, frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 1,
      seconds: [{id: 'second', seatId: 'seconder', seatDisplayName: 'United States',
        createdAt: '2026-08-14T00:00:00.000Z'}], revision: 3,
      directVote: {includeNonVotingSeats: true, startedAt: null, settingsRevision: 1, eligibility: [],
        choices: ['FOR', 'AGAINST', 'ABSTAIN'], threshold: 1, automaticResult: null, votes: []},
      createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null, destinationPath: null};
    const customize = (value: CommitteeWorkspaceSnapshot): CommitteeWorkspaceSnapshot => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}, motions: [motion],
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      ballots: [{id: 'ballot', committeeId: 'committee', meetingSessionId: 'meeting', subjectType: 'MOTION',
        subjectId: 'motion', status: 'OPEN', procedural: false, choices: ['FOR', 'AGAINST', 'ABSTAIN'],
        rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules',
          definition: {}, facts: {}, resolvedValues: {}, frozenAt: '2026-08-14T00:00:00.000Z'},
        eligibility: [{seatId: 'seat', seatDisplayName: 'China', mustVote: false, hasVeto: true}],
        threshold: {kind: 'SIMPLE_MAJORITY', value: 1}, votes: [{id: 'vote', seatId: 'seat', seatDisplayName: 'China',
          choice: 'FOR', revision: 1, castAt: '2026-08-14T00:00:00.000Z'}], result: null, revision: 3,
        openedAt: '2026-08-14T00:00:00.000Z', closedAt: null, publishedAt: null}],
      activeRules: {...value.activeRules, motionTypes: [{id: 'introduce-draft-resolution',
        names: {en: 'Introduce draft resolution', 'zh-CN': '展示决议草案'}, procedural: false,
        requiredSecondCount: 1}]}});
    const page = await render('CHAIR', '/committees/committee/motions', user, customize, {closeBallot});

    expect(page.querySelector('.motion-ballot-panel')?.textContent).toContain('Formal ballot');
    expect(page.querySelector('.motion-ballot-panel')?.textContent).toContain('China: FOR');
    const stop = page.querySelector<HTMLButtonElement>('.motion-stop-voting');
    expect(stop?.textContent?.trim()).toBe('Stop voting');
    expect(stop?.classList.contains('negative')).toBe(true);
    await act(async () => {stop?.click(); await Promise.resolve();});
    expect(closeBallot).toHaveBeenCalledWith('ballot', 3);

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const chairOperatedPage = await render('CHAIR', '/committees/committee/motions', user, value => ({...customize(value),
      committee: {...value.committee, operationMode: 'CHAIR_OPERATED'}}), {closeBallot});
    expect(chairOperatedPage.querySelector('.motion-ballot-panel')).toBeNull();
    expect(chairOperatedPage.querySelector('.motion-stop-voting')).toBeNull();
    expect([...chairOperatedPage.querySelectorAll<HTMLButtonElement>('.motion > .buttons button')]
      .map(button => button.textContent?.trim())).toEqual(['Failed', 'Passed']);
  });

  it('shows current, next, timers, and queue only for the selected speaker list route', async () => {
    const page = await render('CHAIR', '/committees/committee/caucuses/list', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL', status: 'OPEN',
        name: "General Speakers' List", topic: '', defaultSpeechMs: 60_000, delegatesCanQueue: false,
        rulePackageVersionId: 'rules', currentEntryId: 'current', speechTimerId: 'speech-timer',
        totalTimerId: null, linkedResolutionId: null, revision: 2, queue: [
        {id: 'completed-1', seatId: 'seat', seatDisplayName: 'China', position: 1, status: 'COMPLETED', stance: 'NEUTRAL',
          speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'},
        {id: 'completed-2', seatId: 'france', seatDisplayName: 'France', position: 2, status: 'COMPLETED', stance: 'FOR',
          speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'},
        {id: 'current', seatId: 'seat', seatDisplayName: 'China', position: 1,
          status: 'CURRENT', stance: 'NEUTRAL', speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'},
        {id: 'next', seatId: 'france', seatDisplayName: 'France', position: 2, status: 'QUEUED', stance: 'FOR',
          speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'}], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST', ownerId: 'list', running: false,
        startedAt: null, remainingAtStartMs: 60_000, remainingMs: 60_000, revision: 1, expiredAt: null,
        serverTime: '2026-08-14T00:00:00.000Z'}]}));
    expect(page.textContent).toContain('Now speaking');
    expect(page.textContent).toContain('Next speaking');
    expect(page.textContent).toContain('China');
    expect(page.textContent).toContain('France');
    expect(page.textContent).not.toContain('Motion type');
    expect((page.textContent ?? '').indexOf('Next speaking')).toBeLessThan((page.textContent ?? '').indexOf('Queue'));
    const nextPanel = [...page.querySelectorAll<HTMLElement>('.ui.segment')]
      .find(segment => segment.querySelector('.top.left.attached.label')?.textContent === 'Next speaking');
    const queuePanel = [...page.querySelectorAll<HTMLElement>('.ui.segment')]
      .find(segment => segment.querySelector('.top.left.attached.label')?.textContent === 'Queue');
    expect(nextPanel?.textContent).toContain('France');
    expect(nextPanel?.querySelectorAll('.event')).toHaveLength(1);
    expect(nextPanel?.querySelector('.speaker-feed-actions')).toBeNull();
    expect(queuePanel?.textContent).toContain('France');
    expect(queuePanel?.querySelector('.speaker-feed-actions')).not.toBeNull();
    const queueFeed = queuePanel?.querySelector('.feed');
    const queueDropdown = queuePanel?.querySelector('.ui.dropdown');
    expect(queueFeed).not.toBeNull();
    expect(queueDropdown).not.toBeNull();
    expect(queueFeed!.compareDocumentPosition(queueDropdown!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const speakerTimer = [...page.querySelectorAll<HTMLElement>('.proceedings-timer')]
      .find(timer => timer.querySelector('.top.left.attached.label')?.textContent === 'Speaker timer');
    expect(speakerTimer?.querySelector('.speaker-timer-actions')?.textContent).toContain('Start');
    const dividerNavigation = queuePanel?.querySelector('.speaker-queue-divider-navigation');
    expect(dividerNavigation?.querySelectorAll('a')).toHaveLength(2);
    expect(dividerNavigation?.textContent).toContain('Motions');
    expect(dividerNavigation?.textContent).toContain('Question');
    expect(dividerNavigation?.nextElementSibling?.classList.contains('speaker-queue-divider')).toBe(true);
  });

  it('closes the question form only after the contribution is saved and reports the result', async () => {
    const questionSpeech = {id: 'question-speech', speakerListId: 'list', queueEntryId: 'current', seatId: 'france',
      seatDisplayName: 'France', kind: 'INHERITED' as const, status: 'PAUSED' as const, inheritedFromSpeechId: 'original',
      inheritedTimeMs: 30_000, canYield: false, yieldType: 'QUESTIONS' as const, yieldTargetSeatId: null,
      yieldDecisionStatus: null, interactionTargetSeatId: 'france', revision: 1,
      startedAt: '2026-08-14T00:00:00.000Z', endedAt: null, actions: [], contributions: []};
    const withQuestion = (value: CommitteeWorkspaceSnapshot): CommitteeWorkspaceSnapshot => ({...value,
      seats: [...value.seats, {id: 'france', stableKey: 'france', displayName: 'France', rank: 'STANDARD', canVote: true,
        hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1, flag: {type: 'STANDARD', value: 'fr'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL', status: 'OPEN',
        name: "General Speakers' List", topic: '', defaultSpeechMs: 60_000, delegatesCanQueue: false,
        rulePackageVersionId: 'rules', currentEntryId: 'current', speechTimerId: 'speech-timer', totalTimerId: null,
        linkedResolutionId: null, revision: 2, queue: [{id: 'current', seatId: 'seat', seatDisplayName: 'China', position: 1,
          status: 'CURRENT', stance: 'NEUTRAL', speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'}],
        speeches: [questionSpeech], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST', ownerId: 'list', running: false,
        startedAt: null, remainingAtStartMs: 30_000, remainingMs: 30_000, revision: 1, expiredAt: null,
        serverTime: '2026-08-14T00:00:00.000Z'}]});
    vi.useFakeTimers();
    let finishRecord: (value: typeof questionSpeech) => void = () => undefined;
    const recordSpeechContribution = vi.fn(() => new Promise<typeof questionSpeech>(resolve => {finishRecord = resolve;}));
    let page = await render('CHAIR', '/committees/committee/caucuses/list', user, withQuestion, {recordSpeechContribution});
    const textarea = page.querySelector<HTMLTextAreaElement>('.speech-contribution-form textarea');
    expect(textarea?.value).toBe('Q:\n\nA:');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Q: Why?\n\nA: Because.');
      textarea?.dispatchEvent(new Event('input', {bubbles: true}));
      page.querySelector<HTMLButtonElement>('.speech-contribution-form button')?.click();
      await Promise.resolve();
    });
    const savingButton = page.querySelector<HTMLButtonElement>('.speech-contribution-form button');
    expect(savingButton).toMatchObject({disabled: true});
    expect(savingButton?.getAttribute('aria-busy')).toBe('true');
    expect(savingButton?.textContent).toContain('Saving…');
    expect(savingButton?.querySelector('.loading.spinner.icon')).not.toBeNull();
    expect(recordSpeechContribution).toHaveBeenCalledWith('question-speech', 'QUESTION', 'Q: Why?\n\nA: Because.',
      'france', expect.any(AbortSignal));
    await act(async () => {finishRecord(questionSpeech); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();});
    expect(page.querySelector('.speech-contribution-form')).toBeNull();
    expect(page.textContent).not.toContain('may ask a question');
    expect(page.textContent).toContain('Interaction recorded.');
    await act(async () => {await vi.advanceTimersByTimeAsync(4_999);});
    expect(page.textContent).toContain('Interaction recorded.');
    await act(async () => {await vi.advanceTimersByTimeAsync(1);});
    expect(page.textContent).not.toContain('Interaction recorded.');
    vi.useRealTimers();

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const failedRecord = vi.fn(async () => {throw new Error('Save failed');});
    page = await render('CHAIR', '/committees/committee/caucuses/list', user, withQuestion,
      {recordSpeechContribution: failedRecord});
    const failedTextarea = page.querySelector<HTMLTextAreaElement>('.speech-contribution-form textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(failedTextarea, 'Q: Keep this text\n\nA:');
      failedTextarea?.dispatchEvent(new Event('input', {bubbles: true}));
      page.querySelector<HTMLButtonElement>('.speech-contribution-form button')?.click();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(page.querySelector<HTMLTextAreaElement>('.speech-contribution-form textarea')?.value).toBe('Q: Keep this text\n\nA:');
    expect(page.textContent).toContain('Save failed');
    expect(page.textContent).not.toContain('Interaction recorded.');

    act(() => root?.unmount()); page.remove(); root = undefined; container = undefined;
    vi.useFakeTimers();
    try {
      const timedOutRecord = vi.fn((_id: string, _type: 'QUESTION' | 'COMMENT', _content: string,
        _seatId?: string, signal?: AbortSignal) => new Promise<typeof questionSpeech>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
      }));
      page = await render('CHAIR', '/committees/committee/caucuses/list', user, withQuestion,
        {recordSpeechContribution: timedOutRecord});
      const timedOutTextarea = page.querySelector<HTMLTextAreaElement>('.speech-contribution-form textarea');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(timedOutTextarea, 'Q: Timeout text\n\nA:');
        timedOutTextarea?.dispatchEvent(new Event('input', {bubbles: true}));
        page.querySelector<HTMLButtonElement>('.speech-contribution-form button')?.click();
        await vi.advanceTimersByTimeAsync(10_000); await Promise.resolve(); await Promise.resolve();
      });
      expect(page.querySelector<HTMLButtonElement>('.speech-contribution-form button')).toMatchObject({disabled: false});
      expect(page.querySelector<HTMLTextAreaElement>('.speech-contribution-form textarea')?.value).toBe('Q: Timeout text\n\nA:');
      expect(page.textContent).toContain('Saving timed out. Try again.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the legacy one-click moderated-caucus yield while recording the backend decision chain', async () => {
    const pausedSpeech = {id: 'speech', speakerListId: 'list', queueEntryId: 'current', seatId: 'seat',
      seatDisplayName: 'China', kind: 'ORIGINAL' as const, status: 'PAUSED' as const, inheritedFromSpeechId: null,
      inheritedTimeMs: null, canYield: true, yieldType: null, yieldTargetSeatId: null, yieldDecisionStatus: null,
      interactionTargetSeatId: null, revision: 4, startedAt: '2026-08-14T00:00:00.000Z', endedAt: null,
      actions: [], contributions: []};
    const offeredSpeech = {...pausedSpeech, yieldType: 'SEAT' as const, yieldTargetSeatId: 'france',
      yieldDecisionStatus: 'PENDING' as const, revision: 5};
    const commandSpeech = vi.fn(async () => pausedSpeech);
    const commandTimer = vi.fn(async () => ({id: 'total-timer', committeeId: 'committee', ownerType: 'CAUCUS' as const,
      ownerId: 'list', running: false, startedAt: null, remainingAtStartMs: 600_000, remainingMs: 590_000,
      revision: 3, expiredAt: null, serverTime: '2026-08-14T00:00:10.000Z'}));
    const yieldSpeech = vi.fn(async () => offeredSpeech);
    const decideSpeechYield = vi.fn(async (): Promise<SpeakerList> => ({id: 'list', committeeId: 'committee',
      meetingSessionId: 'meeting', kind: 'MODERATED_CAUCUS', status: 'OPEN', name: 'Climate finance',
      topic: 'Climate finance', defaultSpeechMs: 60_000, delegatesCanQueue: false, rulePackageVersionId: 'rules',
      currentEntryId: 'current', speechTimerId: 'speech-timer', totalTimerId: 'total-timer', linkedResolutionId: null, revision: 3,
      queue: [], speeches: [], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}));
    const page = await render('CHAIR', '/committees/committee/caucuses/list', user, value => ({...value,
      layoutSettings: {moveQueueUp: true, timersInSeparateColumns: true},
      seats: [...value.seats, {id: 'france', stableKey: 'france', displayName: 'France', rank: 'STANDARD', canVote: true,
        hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1, flag: {type: 'STANDARD', value: 'fr'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'a', updatedAt: '2026-08-14T00:00:00.000Z'},
        {seatId: 'france', state: 'PRESENT', lastEventId: 'b', updatedAt: '2026-08-14T00:00:00.000Z'}],
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'MODERATED_CAUCUS',
        status: 'OPEN', name: 'Climate finance', topic: 'Climate finance', defaultSpeechMs: 60_000,
        delegatesCanQueue: false, rulePackageVersionId: 'rules', currentEntryId: 'current', speechTimerId: 'speech-timer',
        totalTimerId: 'total-timer', linkedResolutionId: null, revision: 2, queue: [{id: 'current', seatId: 'seat', seatDisplayName: 'China',
          position: 1, status: 'CURRENT', stance: 'NEUTRAL', speechDurationMs: 60_000,
          createdAt: '2026-08-14T00:00:00.000Z'}, {id: 'next', seatId: 'france', seatDisplayName: 'France', position: 2,
          status: 'QUEUED', stance: 'FOR', speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'}],
        speeches: [{...pausedSpeech, status: 'RUNNING', revision: 3}],
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST', ownerId: 'list', running: true,
        startedAt: '2026-08-14T00:00:00.000Z', remainingAtStartMs: 60_000, remainingMs: 50_000, revision: 2,
        expiredAt: null, serverTime: '2026-08-14T00:00:10.000Z'}, {id: 'total-timer', committeeId: 'committee',
        ownerType: 'CAUCUS', ownerId: 'list', running: true, startedAt: '2026-08-14T00:00:00.000Z',
        remainingAtStartMs: 600_000, remainingMs: 590_000, revision: 2, expiredAt: null,
        serverTime: '2026-08-14T00:00:10.000Z'}]}), {commandSpeech, commandTimer, yieldSpeech, decideSpeechYield});

    expect(page.querySelector('.speaker-timer-column')?.textContent).toContain('Speaker timer');
    expect(page.querySelector('.speaker-timer-column')?.textContent).toContain('Now speaking');
    expect(page.querySelector('.caucus-timer-column')?.textContent).toContain('Caucus timer');
    expect(page.querySelector('.caucus-timer-column')?.textContent).toContain('Queue');
    const nextPanel = [...page.querySelectorAll<HTMLElement>('.ui.segment')]
      .find(segment => segment.querySelector('.top.left.attached.label')?.textContent === 'Next speaking');
    const queuePanel = [...page.querySelectorAll<HTMLElement>('.ui.segment')]
      .find(segment => segment.querySelector('.top.left.attached.label')?.textContent === 'Queue');
    expect(nextPanel?.querySelectorAll('.event')).toHaveLength(1);
    expect(nextPanel?.querySelector('.speaker-feed-actions')).toBeNull();
    expect(queuePanel?.textContent).toContain('France');
    expect(queuePanel?.querySelector('.speaker-feed-actions')).not.toBeNull();
    expect(page.querySelector('.speaker-timer-column .speaker-timer-actions')?.textContent).toContain('Next');
    const caucusTimerButton = page.querySelector<HTMLButtonElement>('.caucus-timer-column .legacy-timer-display');
    await act(async () => {caucusTimerButton?.click(); await Promise.resolve();});
    expect(commandTimer).toHaveBeenCalledWith('total-timer', 'pause', 2, undefined);
    expect(commandSpeech).not.toHaveBeenCalled();

    const yieldButton = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Yield');
    expect(yieldButton).not.toBeUndefined();
    await act(async () => {yieldButton?.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();});
    expect(commandSpeech).toHaveBeenCalledWith('list', 'pause', 3);
    expect(yieldSpeech).toHaveBeenCalledWith('speech', 4, 'SEAT', 'france');
    expect(decideSpeechYield).toHaveBeenCalledWith('speech', 5, 'ACCEPT');
  });

  it('shows the delegate queue switch only in delegate-operated mode', async () => {
    const withList = (value: CommitteeWorkspaceSnapshot, operationMode: 'CHAIR_OPERATED' | 'DELEGATE_OPERATED') => ({
      ...value, committee: {...value.committee, operationMode},
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN' as const, revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL' as const,
        status: 'OPEN' as const, name: "General Speakers' List", topic: '', defaultSpeechMs: 60_000,
        delegatesCanQueue: true, rulePackageVersionId: 'rules', currentEntryId: null, speechTimerId: 'speech-timer',
        totalTimerId: null, linkedResolutionId: null, revision: 2, queue: [], speeches: [], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST' as const, ownerId: 'list',
        running: false, startedAt: null, remainingAtStartMs: 60_000, remainingMs: 60_000, revision: 1,
        expiredAt: null, serverTime: '2026-08-14T00:00:00.000Z'}]
    });
    const checkbox = (page: HTMLDivElement) => [...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(input => input.closest('.field')?.textContent?.includes('Delegates can queue'));

    let page = await render('CHAIR', '/committees/committee/caucuses/list', user,
      value => withList(value, 'CHAIR_OPERATED'));
    expect(checkbox(page)).toBeUndefined();
    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    page = await render('CHAIR', '/committees/committee/caucuses/list', user,
      value => withList(value, 'DELEGATE_OPERATED'));
    expect(checkbox(page)).toMatchObject({checked: true, disabled: false});
    expect(page.querySelector(".speaker-queue-delegate-toggle")).toBeTruthy();
    expect([...page.querySelectorAll("button")].find(button => button.textContent?.trim() === "Join queue")).toBeTruthy();
    expect(page.textContent).not.toContain("For");
    expect(page.textContent).not.toContain("Neutral");
    expect(page.textContent).not.toContain("Against");
  });

  it('persists both legacy workspace layout switches as one revisioned setting command', async () => {
    const setLayoutSettings = vi.fn(async () => ({moveQueueUp: true, timersInSeparateColumns: true, revision: 5}));
    const page = await render('CHAIR', '/committees/committee/settings', user, value => ({...value,
      layoutSettings: {moveQueueUp: false, timersInSeparateColumns: true}
    }), {setLayoutSettings});
    const queueSwitch = [...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(input => input.closest('.checkbox')?.textContent?.includes("'Queue' should appear above 'Next speaking'"));
    expect(queueSwitch).toMatchObject({checked: false, disabled: false});

    await act(async () => {clickSemanticCheckbox(queueSwitch); await Promise.resolve(); await Promise.resolve();});
    expect(setLayoutSettings).toHaveBeenCalledWith('committee',
      {moveQueueUp: true, timersInSeparateColumns: true}, 4);
  });

  it('creates a system-named strawpoll immediately from the plus route', async () => {
    const created: CreatedStrawpoll = {id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting',
      question: 'New strawpoll 1', votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN',
      stage: 'PREPARING', medium: 'LINK', optionsArePublic: false, seriesId: 'poll', roundNumber: 1,
      supersededById: null, options: [], seatVotes: [], revision: 1,
      createdAt: '2026-08-14T00:00:00.000Z', closedAt: null};
    const createStrawpoll = vi.fn(async () => created);
    await render('CHAIR', '/committees/committee/strawpolls/new', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}), {createStrawpoll});
    expect(createStrawpoll).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', question: '',
      votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, options: [], medium: 'LINK', optionsArePublic: false});
  });

  it('submits an anonymous strawpoll once and locks every answer afterward', async () => {
    const voteStrawpoll = vi.fn(async (): Promise<Strawpoll> => ({} as Strawpoll));
    const page = await render('MEMBER', '/committees/committee/strawpolls/poll', user, value => ({...value,
      strawpolls: [{id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', question: 'Preferred option?',
        votingMode: 'ANONYMOUS', multipleChoice: false, status: 'OPEN', stage: 'VOTING', medium: 'LINK',
        optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null,
        options: [{id: 'one', label: 'Option one', sortOrder: 0, voteCount: 0},
          {id: 'two', label: 'Option two', sortOrder: 1, voteCount: 0}], seatVotes: [], revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}]}), {voteStrawpoll});
    const token = page.querySelector<HTMLInputElement>('[data-strawpoll-token] input');
    expect(token).not.toBeNull();
    expect(page.querySelectorAll('.strawpoll-page .ui.checkbox')).toHaveLength(2);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(token, 'secret-code');
      token?.dispatchEvent(new Event('input', {bubbles: true}));
      clickSemanticCheckbox(page.querySelectorAll<HTMLElement>('.strawpoll-page .ui.checkbox')[0]);
      await Promise.resolve();
    });
    const vote = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Vote');
    expect(vote).not.toBeUndefined();
    await act(async () => {vote?.click(); await Promise.resolve(); await Promise.resolve();});
    expect(voteStrawpoll).toHaveBeenCalledTimes(1);
    expect(voteStrawpoll).toHaveBeenCalledWith('poll', {optionIds: ['one'], anonymousAccessToken: 'secret-code'});
    expect(vote?.disabled).toBe(true);
    expect(page.querySelector<HTMLInputElement>('[data-strawpoll-option="two"] input')?.disabled).toBe(true);
    await act(async () => {vote?.click(); await Promise.resolve();});
    expect(voteStrawpoll).toHaveBeenCalledTimes(1);
  });

  it('keeps seat-authenticated strawpoll answers as direct changeable and retractable clicks', async () => {
    const voteStrawpoll = vi.fn(async (): Promise<Strawpoll> => ({} as Strawpoll));
    const page = await render('MEMBER', '/committees/committee/strawpolls/poll', user, value => ({...value,
      strawpolls: [{id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', question: 'Preferred option?',
        votingMode: 'SEAT_AUTHENTICATED', multipleChoice: false, status: 'OPEN', stage: 'VOTING', medium: 'LINK',
        optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null,
        options: [{id: 'one', label: 'Option one', sortOrder: 0, voteCount: 1},
          {id: 'two', label: 'Option two', sortOrder: 1, voteCount: 0}],
        seatVotes: [{id: 'vote', seatId: 'seat', optionIds: ['one'], revision: 1,
          castAt: '2026-08-14T00:00:00.000Z'}], revision: 2,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}]}), {voteStrawpoll});
    const choices = page.querySelectorAll<HTMLElement>('.strawpoll-page .ui.checkbox');
    expect(choices).toHaveLength(2);
    await act(async () => {clickSemanticCheckbox(choices[1]); await Promise.resolve();});
    await act(async () => {clickSemanticCheckbox(choices[0]); await Promise.resolve();});
    expect(voteStrawpoll).toHaveBeenNthCalledWith(1, 'poll', {optionIds: ['two']});
    expect(voteStrawpoll).toHaveBeenNthCalledWith(2, 'poll', {optionIds: []});
  });

  it('keeps manual tallies and the legacy results progress view separate from linked voting', async () => {
    const setStrawpollManualTally = vi.fn(async (): Promise<Strawpoll> => ({} as Strawpoll));
    const manual: Strawpoll = {id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', question: 'Count?',
      votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN', stage: 'VOTING', medium: 'MANUAL',
      optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null,
      options: [{id: 'one', label: 'Option one', sortOrder: 0, voteCount: 3}], seatVotes: [], revision: 4,
      createdAt: '2026-08-14T00:00:00.000Z', closedAt: null};
    const page = await render('CHAIR', '/committees/committee/strawpolls/poll', user,
      value => ({...value, strawpolls: [manual]}), {setStrawpollManualTally});
    const tally = page.querySelector<HTMLInputElement>('[data-strawpoll-manual="one"] input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(tally, '5');
      tally?.dispatchEvent(new Event('input', {bubbles: true})); tally?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
      await Promise.resolve();
    });
    expect(setStrawpollManualTally).toHaveBeenCalledWith('poll', 4, 'one', 5);
    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const results = await render('CHAIR', '/committees/committee/strawpolls/poll', user, value => ({...value,
      strawpolls: [{...manual, status: 'CLOSED', stage: 'RESULTS', closedAt: '2026-08-14T00:01:00.000Z'}]}));
    expect(results.querySelector('.ui.progress')).not.toBeNull();
    expect(results.textContent).toContain('3 votes');
    expect(results.textContent).toContain('Reopen voting');
  });

  it('keeps only text, amendments, and voting after the resolution feed is removed', async () => {
    const page = await render('PUBLIC', '/committees/committee/resolutions/resolution/text', user, value => ({...value,
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION', resolutionId: null,
        title: 'Climate resolution', status: 'PUBLISHED', rulePackageVersionId: 'rules', currentVersion: {id: 'version',
          versionNumber: 1, content: 'Operative text', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
        public: true, proposerSeatId: null, seconderSeatId: null, delegatesCanAmend: false,
        directVote: {majority: 'SIMPLE_MAJORITY', startedAt: null, settingsRevision: 1, eligibility: [], threshold: 0,
          automaticResult: null, votes: []}, resultDecisions: [], revision: 2, discussion: [],
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}]}));
    expect(page.textContent).toContain('Text');
    expect(page.textContent).toContain('Amendments');
    expect(page.textContent).toContain('Voting');
    expect(page.textContent).not.toContain('Feed');
    expect(page.textContent).toContain('Operative text');
  });

  it('restores the legacy amendment cards, immediate plus, and guarded trash action', async () => {
    const createAmendment = vi.fn(async (): Promise<ProceedingDocument> => ({} as ProceedingDocument));
    const deleteAmendment = vi.fn(async () => ({id: 'amendment', deleted: true as const}));
    const resolution: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, title: 'New draft resolution 1', status: 'PUBLISHED',
      rulePackageVersionId: 'rules', currentVersion: {id: 'resolution-version', versionNumber: 1,
        content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
      public: true, proposerSeatId: 'seat', seconderSeatId: null, delegatesCanAmend: false, directVote: null,
      resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const amendment: ProceedingDocument = {...resolution, id: 'amendment', kind: 'AMENDMENT',
      resolutionId: 'resolution', title: 'New amendment 1', status: 'DRAFT', public: false,
      currentVersion: {id: 'amendment-version', versionNumber: 1, content: 'Replace clause 1', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, revision: 1};
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/amendments', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}], documents: [resolution, amendment]}),
    {createAmendment, deleteAmendment});
    expect(page.querySelectorAll('.amendment-card')).toHaveLength(1);
    expect([...page.querySelectorAll<HTMLInputElement>('.amendment-card input')]
      .some(input => input.value === 'New amendment 1')).toBe(true);
    expect(page.textContent).toContain('Replace clause 1');
    const add = page.querySelector<HTMLButtonElement>('button[aria-label="Create amendment"]');
    await act(async () => {add?.click(); await Promise.resolve();});
    expect(createAmendment).toHaveBeenCalledWith('resolution',
      {meetingSessionId: 'meeting', title: '', content: '', onBehalfOfSeatId: 'seat'});
    const trash = page.querySelector<HTMLButtonElement>('.amendment-card button[aria-label="Delete"]');
    expect(trash?.disabled).toBe(false);
    await act(async () => {trash?.click(); await Promise.resolve();});
    expect(deleteAmendment).toHaveBeenCalledWith('amendment', 1);
  });

  it('opens and embeds the retained formal ballot from a voting amendment card', async () => {
    const createBallot = vi.fn(async () => ({}));
    const resolution: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, title: 'New draft resolution 1', status: 'PUBLISHED',
      rulePackageVersionId: 'rules', currentVersion: {id: 'resolution-version', versionNumber: 1,
        content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
      public: true, proposerSeatId: 'seat', seconderSeatId: null, delegatesCanAmend: false, directVote: null,
      resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const amendment: ProceedingDocument = {...resolution, id: 'amendment', kind: 'AMENDMENT',
      resolutionId: 'resolution', title: 'New amendment 1', status: 'VOTING', votingVersionId: 'amendment-version',
      currentVersion: {id: 'amendment-version', versionNumber: 1, content: 'Replace clause 1', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, revision: 3};
    const base = (value: CommitteeWorkspaceSnapshot) => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN' as const, revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT' as const, lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}], documents: [resolution, amendment]});
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/amendments', user, base,
      {createBallot: createBallot as unknown as SelfHostedApi['createBallot']});
    const open = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Open substantive ballot');
    expect(open).toBeDefined();
    expect(page.querySelector<HTMLButtonElement>('.amendment-card button[aria-label="Delete"]')?.disabled).toBe(true);
    await act(async () => {open?.click(); await Promise.resolve();});
    expect(createBallot).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', subjectType: 'AMENDMENT',
      subjectId: 'amendment', procedural: false, thresholdKind: 'SIMPLE_MAJORITY'});

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const ballotPage = await render('CHAIR', '/committees/committee/resolutions/resolution/amendments', user,
      value => ({...base(value), ballots: [{id: 'ballot', committeeId: 'committee', meetingSessionId: 'meeting',
        subjectType: 'AMENDMENT', subjectId: 'amendment', status: 'OPEN', procedural: false,
        choices: ['FOR', 'AGAINST', 'ABSTAIN'], rulePackageVersionId: 'rules',
        ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {},
          frozenAt: '2026-08-14T00:00:00.000Z'}, eligibility: [{seatId: 'seat', seatDisplayName: 'China',
          mustVote: false, hasVeto: true}], threshold: {kind: 'SIMPLE_MAJORITY', value: 1}, votes: [], result: null,
        revision: 1, openedAt: '2026-08-14T00:00:00.000Z', closedAt: null, publishedAt: null}]}));
    expect(ballotPage.textContent).toContain('Formal ballot');
    expect(ballotPage.textContent).toContain('FOR');
    expect(ballotPage.textContent).toContain('AGAINST');
  });

  it('creates an empty, system-named draft immediately from the resolution plus route', async () => {
    const created: ProceedingDocument = {id: 'created-resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, title: 'New draft resolution 1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: false, proposerSeatId: null,
      seconderSeatId: null, delegatesCanAmend: false, directVote: null, resultDecisions: [], revision: 1,
      discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    const createResolution = vi.fn(async () => created);
    await render('CHAIR', '/committees/committee/resolutions/new', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}), {createResolution});
    expect(createResolution).toHaveBeenCalledTimes(1);
    expect(createResolution).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', title: '', content: ''});
  });

  it('uploads a resolution body file and attaches it as the new document version', async () => {
    const document: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, title: 'New draft resolution 1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: false, proposerSeatId: null,
      seconderSeatId: null, delegatesCanAmend: false, directVote: null, resultDecisions: [], revision: 1,
      discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    const uploadedFile = {id: 'file', committeeId: 'committee', logicalName: 'draft.pdf', mediaType: 'application/pdf',
      status: 'UPLOAD_COMPLETE' as const, syncState: 'SYNCED' as const, createdByUserId: 'user',
      currentVersion: {id: 'file-version', versionNumber: 1, originalName: 'draft.pdf', mediaType: 'application/pdf',
        sizeBytes: 4, sha256: 'a'.repeat(64), blobId: 'blob', createdAt: '2026-08-14T00:00:00.000Z'},
      revision: 1, submittedAt: null, publishedAt: null, createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const createFileUpload = vi.fn(async () => ({id: 'upload'} as never));
    const uploadFileContent = vi.fn(async () => ({id: 'upload'} as never));
    const commitFileUpload = vi.fn(async () => uploadedFile);
    const createDocumentVersion = vi.fn(async () => document);
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/text', user,
      value => ({...value, documents: [document]}), {listFiles: vi.fn(async () => []), createFileUpload,
        uploadFileContent, commitFileUpload, createDocumentVersion});

    const fileMode = page.querySelectorAll<HTMLButtonElement>('.resolution-content-source button')[1];
    await act(async () => {fileMode?.click(); await Promise.resolve();});
    const input = page.querySelector<HTMLInputElement>('input[aria-label="Resolution file"]');
    const body = new File(['body'], 'draft.pdf', {type: 'application/pdf'});
    await act(async () => {
      Object.defineProperty(input, 'files', {configurable: true, value: [body]});
      input?.dispatchEvent(new Event('change', {bubbles: true})); await Promise.resolve();
    });
    const upload = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Upload file');
    await act(async () => {upload?.click(); for (let index = 0; index < 8; index += 1) await Promise.resolve();});

    expect(createFileUpload).toHaveBeenCalledWith('committee', expect.objectContaining({logicalName: 'draft.pdf',
      originalName: 'draft.pdf', mediaType: 'application/pdf', expectedSizeBytes: 4, sha256: 'a'.repeat(64)}),
    expect.any(String));
    expect(uploadFileContent).toHaveBeenCalledWith('upload', body, expect.any(String), expect.any(Object));
    expect(commitFileUpload).toHaveBeenCalledWith('upload', expect.any(String));
    expect(createDocumentVersion).toHaveBeenCalledWith('resolution', {baseRevision: 1,
      title: 'New draft resolution 1', content: '', contentFileEntryId: 'file', onBehalfOfSeatId: 'seat'});
  });

  it('publishes an attached resolution file through the existing review workflow', async () => {
    const file = {id: 'file', committeeId: 'committee', logicalName: 'draft.pdf', mediaType: 'application/pdf',
      status: 'PENDING_REVIEW' as const, syncState: 'SYNCED' as const, createdByUserId: 'user',
      currentVersion: {id: 'file-version', versionNumber: 1, originalName: 'draft.pdf', mediaType: 'application/pdf',
        sizeBytes: 4, sha256: 'a'.repeat(64), blobId: 'blob', createdAt: '2026-08-14T00:00:00.000Z'},
      revision: 2, submittedAt: '2026-08-14T00:01:00.000Z', publishedAt: null,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:01:00.000Z'};
    const document: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, title: 'New draft resolution 1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 2, content: '', contentFile: {
        id: 'file', logicalName: 'draft.pdf', originalName: 'draft.pdf', mediaType: 'application/pdf',
        status: 'PENDING_REVIEW'}, createdAt: '2026-08-14T00:01:00.000Z'}, votingVersionId: null, public: false,
      proposerSeatId: null, seconderSeatId: null, delegatesCanAmend: false, directVote: null, resultDecisions: [],
      revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:01:00.000Z'};
    const publishFile = vi.fn(async () => ({...file, status: 'PUBLISHED' as const, revision: 3,
      publishedAt: '2026-08-14T00:02:00.000Z'}));
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/text', user,
      value => ({...value, documents: [document]}), {listFiles: vi.fn(async () => [file]), publishFile});
    await act(async () => {await Promise.resolve(); await Promise.resolve();});
    const publish = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Publish file');
    expect(publish?.disabled).toBe(false);
    await act(async () => {publish?.click(); await Promise.resolve();});
    expect(publishFile).toHaveBeenCalledWith('file', 2);
  });

  it('restores the legacy resolution voting matrix without removing the formal ballot area', async () => {
    const setResolutionDirectVote = vi.fn(async (): Promise<ProceedingDocument> => ({} as ProceedingDocument));
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/voting', user, value => ({...value,
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION',
        resolutionId: null, title: 'A/RES/1', status: 'PUBLISHED', rulePackageVersionId: 'rules',
        currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'},
        votingVersionId: null, public: true, proposerSeatId: 'seat', seconderSeatId: null, delegatesCanAmend: false,
        directVote: {majority: 'SIMPLE_MAJORITY', startedAt: null, settingsRevision: 1,
          eligibility: [{seatId: 'seat', seatDisplayName: 'China', mustVote: false, hasVeto: true}], threshold: 1,
          automaticResult: null, votes: []}, resultDecisions: [], revision: 2, discussion: [],
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}]}),
    {setResolutionDirectVote});
    expect(page.querySelector('.resolution-voting-board')).not.toBeNull();
    expect(page.querySelectorAll('.resolution-voting-member')).toHaveLength(1);
    expect(page.textContent).toContain('Now voting');
    expect(page.textContent).toContain('Formal ballot');
    const yes = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'yes');
    await act(async () => {yes?.click(); await Promise.resolve();});
    expect(setResolutionDirectVote).toHaveBeenCalledWith('resolution', 'seat', 'FOR');
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
        seconds: [], directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1,
          eligibility: [], choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []},
        revision: 1, createdAt: '2026-08-14T00:00:00.000Z', decidedAt: '2026-08-14T00:00:00.000Z',
        destinationPath: null}]}));
    const stats = page.querySelector('.committee-workspace-page')?.textContent ?? '';
    expect(stats).toContain('Times spoken');
    expect(stats).toContain('Total speaking time');
    expect(stats).toContain('Motion proposals');
    expect(stats).toContain('Amendment proposals');
    expect(stats).toContain('Document discussion entries');
    expect(stats).toContain('China');
  });
  it('restores a dedicated link-resource route with its publisher', async () => { const page = await render('CHAIR', '/committees/committee/posts/links', user, value => ({...value, textPosts: [{id: 'link', title: 'Research', content: 'link:https://example.test/research', sortOrder: 0, revision: 1, authorSeatId: 'seat', authorDisplayName: 'China', actorUserId: 'chair', createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', deletedAt: null}]})); expect(page.textContent).toContain('Link resources'); expect(page.textContent).toContain('Publisher: China'); expect(page.querySelector('a[href="https://example.test/research"]')).not.toBeNull(); });
  it('keeps the strawpoll page mounted while typing a newly added option', async () => { const page = await render('CHAIR', '/committees/committee/strawpolls/poll', user, value => ({...value, strawpolls: [{id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', question: 'Choice?', votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN', stage: 'PREPARING', medium: 'LINK', optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null, options: [], seatVotes: [], revision: 1, createdAt: '2026-08-16T00:00:00.000Z', closedAt: null}]})); const add = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Add option')); await act(async () => {add?.click(); await Promise.resolve();}); const option = page.querySelectorAll<HTMLInputElement>('.strawpoll-page input')[1]; await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(option, 'Option A'); option?.dispatchEvent(new Event('input', {bubbles: true})); await Promise.resolve();}); expect(page.querySelector('.strawpoll-page')).not.toBeNull(); expect(page.textContent).toContain('Create manual poll'); });
});
