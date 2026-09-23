import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteePoint, CommitteeWorkspaceSnapshot, CreatedStrawpoll, ProceedingDocument, ProceedingMotion, RollCall,
  SpeakerList, Strawpoll} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {SelfHostedUser} from '../../services/self-hosted-identity';
import {setLanguage} from '../../i18n';
import SelfHostedWorkspace from '../SelfHostedWorkspace';
import {generalQueueHasDividerBefore, legacyInterlacedQueue} from './ProceedingsPanel';

vi.mock('../../services/sha256', () => ({sha256File: vi.fn(async () => 'a'.repeat(64))}));

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const user: SelfHostedUser = {id: 'user', email: 'user@example.com', displayName: 'User', status: 'ACTIVE',
  isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null};

function snapshot(audience: CommitteeWorkspaceSnapshot['viewer']['audience']): CommitteeWorkspaceSnapshot {
  return {schemaVersion: 3, ...(audience === 'CHAIR' || audience === 'OWNER' ? {countryTemplate: {
    id: 'builtin:default', key: 'builtin:default', builtin: true, names: {en: 'Default countries'}, defaultLanguage: 'en',
    countryLanguages: ['en'], revision: 1, createdAt: null, updatedAt: null, countries: [{id: 'country-france',
      stableKey: 'france', names: {en: 'France'}, defaultLanguage: 'en', continent: null, sortOrder: 1,
      flag: {type: 'STANDARD', value: 'fr'}, revision: 1}]}} : {}), committee: {committeeLanguage: 'en', id: 'committee', name: 'Security Council', chairLabel: 'Chair',
    topic: 'Climate security', conference: 'Main Hall', visibility: 'PUBLIC', operationMode: 'DELEGATE_OPERATED',
    status: 'ACTIVE', activeRulePackageVersionId: 'rules', revision: 4}, seats: [{id: 'seat', stableKey: 'china',
    displayName: 'China', rank: 'STANDARD', canVote: true, hasVeto: true, mustVote: false, sortOrder: 0, active: true,
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
afterEach(() => {if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined;
  setLanguage('en'); vi.useRealTimers();});

async function render(audience: CommitteeWorkspaceSnapshot['viewer']['audience'], path: string,
  currentUser: SelfHostedUser = user,
  customize: (value: CommitteeWorkspaceSnapshot) => CommitteeWorkspaceSnapshot = value => value,
  apiOverrides: Partial<SelfHostedApi> = {}) {
  const api = {snapshot: vi.fn(async () => customize(snapshot(audience))), openCommitteeEvents: vi.fn(() => () => undefined),
    committeeExportUrl: vi.fn(() => '/api/v1/committees/committee/export'), listRulePackages: vi.fn(async () => []),
    fileDownloadUrl: vi.fn((fileId: string) => `/api/v1/files/${fileId}/download`),
    listStorageBindings: vi.fn(async () => []), listFiles: vi.fn(async () => []),
    listPendingHostCommits: vi.fn(async () => []), listS3ProviderConfigs: vi.fn(async () => []),
    listStorageMigrations: vi.fn(async () => []), listStorageHosts: vi.fn(async () => []),
    listStorageAgentConflicts: vi.fn(async () => []), getDelegateFileShare: vi.fn(async () => null),
    listDelegateReviewFiles: vi.fn(async () => []),
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
  it.each(['start', 'set'] as const)('shows the unmoderated timer immediately and creates it on %s', async action => {
    const timer = {id: 'unmod-timer', committeeId: 'committee', ownerType: 'COMMITTEE' as const, ownerId: 'committee',
      running: false, startedAt: null, remainingAtStartMs: 600_000, remainingMs: 600_000,
      revision: 1, expiredAt: null, serverTime: '2026-09-16T00:00:00.000Z'};
    const createTimer = vi.fn(async () => timer);
    const commandTimer = vi.fn(async () => ({...timer, running: true, revision: 2}));
    const page = await render('CHAIR', '/committees/committee/unmod', user, value => value, {createTimer, commandTimer});
    expect(page.querySelector('time')?.textContent).toBe('10:00');
    expect(page.textContent).not.toContain('Create timer');
    expect(createTimer).not.toHaveBeenCalled();
    const button = action === 'start' ? page.querySelector<HTMLButtonElement>('.legacy-timer-display')
      : [...page.querySelectorAll('button')].find(item => item.textContent === 'Set');
    await act(async () => {button?.click();});
    expect(createTimer).toHaveBeenCalledTimes(1);
    expect(createTimer).toHaveBeenCalledWith('committee', 'COMMITTEE', 'committee', 600_000);
    if (action === 'start') expect(commandTimer).toHaveBeenCalledWith('unmod-timer', 'start', 1, undefined);
    else expect(commandTimer).not.toHaveBeenCalled();
  });

  it('shows a read-only unmoderated timer to viewers before one has been saved', async () => {
    const createTimer = vi.fn();
    const page = await render('PUBLIC', '/committees/committee/unmod', user, value => value, {createTimer});
    expect(page.querySelector('time')?.textContent).toBe('10:00');
    expect(page.querySelector<HTMLButtonElement>('.legacy-timer-display')?.disabled).toBe(true);
    expect(page.querySelector('.proceedings-timer form')).toBeNull();
    expect(createTimer).not.toHaveBeenCalled();
  });

  it('lets each committee page own its layout inside a full-width workspace shell', async () => {
    const page = await render('OWNER', '/committees/committee/roll-call');
    const workspace = page.querySelector('.committee-workspace-page');

    expect(workspace?.classList.contains('fluid')).toBe(true);
    expect(workspace?.querySelector(':scope > .roll-call-start-card')).toBeTruthy();
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
    expect(page.textContent).toContain('Active');
    expect(page.textContent).toContain('Share committee');
    expect(page.textContent).not.toContain('Create seat');
    expect(page.textContent).not.toContain('Grant Chair');
  });

  it('lets Chairs manage seats, assignments, and one-time invitations from setup', async () => {
    const page = await render('CHAIR', '/committees/committee/setup');
    expect(page.querySelector('[aria-label="Create seat"]')).toBeTruthy();
    expect(page.querySelector('[aria-label="Seat name"]')).toBeNull();
    expect(page.textContent).toContain('France');
    expect(page.textContent).toContain('No abstention');
    expect(page.querySelector('.committee-setup-page > .ui.grid')).toBeTruthy();
    expect(page.textContent).toContain('Assign seat');
    expect(page.textContent).toContain('Create invitation');
    expect(page.textContent).not.toContain('Grant Chair');
  });

  it('hides seat creation when all template countries are seated and restores it after deactivation', async () => {
    let franceSeated = true;
    const updateSeat = vi.fn(async () => {franceSeated = false;}) as unknown as SelfHostedApi['updateSeat'];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value,
        seats: franceSeated ? [...value.seats, {...value.seats[0], id: 'france-seat', stableKey: 'france',
          displayName: 'France'}] : value.seats}), {updateSeat});
      expect(page.querySelector('.seat-create-table')).toBeNull();
      expect(page.querySelector('.seat-list-table')?.textContent).toContain('France');

      await act(async () => {page.querySelector<HTMLButtonElement>('[aria-label="Deactivate · France"]')?.click();});
      expect(updateSeat).toHaveBeenCalledWith('committee', 'france-seat', 2, {active: false});
      expect(page.querySelector('.seat-create-table')).toBeTruthy();
      expect(page.querySelector('[aria-label="Create seat"]')).toBeTruthy();
    } finally {confirm.mockRestore();}
  });

  it('preserves the fixed member name instead of overwriting it from the country directory', async () => {
    const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value,
      seats: [...value.seats, {...value.seats[0], id: 'france-seat', stableKey: 'france', displayName: 'French delegation'}]}));
    expect(page.querySelector('.seat-list-table')?.textContent).toContain('French delegation');
    expect(page.querySelector('.seat-list-table')?.textContent).toContain('China');
    expect(page.querySelector('[aria-label="Voting · French delegation"]')).toBeTruthy();
    expect(page.querySelector('[aria-label="Veto · French delegation"]')).toBeTruthy();
  });

  it('lets only Owners manage Chairs', async () => {
    const page = await render('OWNER', '/committees/committee/setup');
    expect(page.textContent).toContain('Grant Chair');
    expect(page.querySelector('.committee-chairs-table')?.textContent).toContain('Revoke');
    expect(page.querySelectorAll('.committee-setup-page .ui.card')).toHaveLength(3);
  });

  it('updates all seats while preserving voting constraints and skips unchanged seats', async () => {
    vi.useFakeTimers();
    const updateSeat = vi.fn(async () => ({})) as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value,
      seats: [value.seats[0], {...value.seats[0], id: 'second', displayName: 'France', rank: 'STANDARD',
        hasVeto: false, mustVote: true, revision: 3}]}), {updateSeat});
    const all = page.querySelector('.all-seats-row')!;
    expect(all.querySelector('button')).toBeNull();
    expect(all.querySelector<HTMLInputElement>('[aria-label="Voting · All seats"]')?.disabled).toBe(false);
    expect(all.querySelector('.toggle.indeterminate')).toBeTruthy();
    expect(all.querySelectorAll('.toggle.checkbox')).toHaveLength(3);
    expect(page.querySelectorAll('.members-table thead.full-width')).toHaveLength(2);
    await act(async () => {clickSemanticCheckbox(all.querySelector('[aria-label="No abstention · All seats"]')?.parentElement);});
    expect(updateSeat).not.toHaveBeenCalled();
    await act(async () => {await vi.advanceTimersByTimeAsync(1500);});
    expect(updateSeat).toHaveBeenCalledTimes(1);
    expect(updateSeat).toHaveBeenCalledWith('committee', 'seat', 2, {canVote: true, hasVeto: true, mustVote: true});
  });

  it('clears no-abstention when all voting rights are removed', async () => {
    vi.useFakeTimers();
    const updateSeat = vi.fn(async () => ({})) as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value,
      seats: [{...value.seats[0], rank: 'STANDARD', hasVeto: false, mustVote: true},
        {...value.seats[0], id: 'second', rank: 'OBSERVER', hasVeto: false}]}), {updateSeat});
    await act(async () => {clickSemanticCheckbox(page.querySelector('[aria-label="Voting · All seats"]')?.parentElement);});
    expect(updateSeat).not.toHaveBeenCalled();
    expect(page.querySelector<HTMLInputElement>('[aria-label="No abstention · China"]')?.checked).toBe(false);
    await act(async () => {await vi.advanceTimersByTimeAsync(1500);});
    expect(updateSeat).toHaveBeenCalledTimes(2);
    expect(updateSeat).toHaveBeenCalledWith('committee', 'seat', 2, {canVote: false, hasVeto: false, mustVote: false});
    expect(updateSeat).toHaveBeenCalledWith('committee', 'second', 2, {canVote: false, hasVeto: false, mustVote: false});
  });

  it('previews repeated bulk clicks immediately and saves only after the last 1.5 seconds', async () => {
    vi.useFakeTimers();
    let finishSave!: () => void;
    const updateSeat = vi.fn(() => new Promise<void>(resolve => {finishSave = resolve;})) as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => value, {updateSeat});
    const all = () => page.querySelector<HTMLInputElement>('[aria-label="No abstention · All seats"]')!;
    const seat = () => page.querySelector<HTMLInputElement>('[aria-label="No abstention · China"]')!;
    await act(async () => {clickSemanticCheckbox(all().parentElement);});
    expect(seat().checked).toBe(true);
    expect(all().disabled).toBe(false);
    await act(async () => {await vi.advanceTimersByTimeAsync(1000); clickSemanticCheckbox(all().parentElement);});
    expect(seat().checked).toBe(false);
    await act(async () => {await vi.advanceTimersByTimeAsync(1000); clickSemanticCheckbox(all().parentElement);});
    expect(seat().checked).toBe(true);
    await act(async () => {await vi.advanceTimersByTimeAsync(1499);});
    expect(updateSeat).not.toHaveBeenCalled();
    expect(all().disabled).toBe(false);
    await act(async () => {await vi.advanceTimersByTimeAsync(1);});
    expect(updateSeat).toHaveBeenCalledTimes(1);
    expect(all().disabled).toBe(true);
    expect(seat().disabled).toBe(true);
    await act(async () => {finishSave();});
  });

  it('remembers the last uniform state after a country is changed individually', async () => {
    vi.useFakeTimers();
    const seats = [snapshot('CHAIR').seats[0], {...snapshot('CHAIR').seats[0], id: 'second', displayName: 'France'}]
      .map(seat => ({...seat, mustVote: true}));
    const updateSeat = vi.fn(async (_committee, id, _revision, patch) => {
      Object.assign(seats.find(seat => seat.id === id)!, patch);
      return {};
    }) as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value, seats}), {updateSeat});
    await act(async () => {clickSemanticCheckbox(page.querySelector('[aria-label="No abstention · China"]')?.parentElement);});
    expect(page.querySelector('.all-seats-row .indeterminate')).toBeTruthy();
    vi.mocked(updateSeat).mockClear();
    await act(async () => {clickSemanticCheckbox(page.querySelector('[aria-label="No abstention · All seats"]')?.parentElement);});
    expect(page.querySelector<HTMLInputElement>('[aria-label="No abstention · France"]')?.checked).toBe(false);
    expect(updateSeat).not.toHaveBeenCalled();
    await act(async () => {await vi.advanceTimersByTimeAsync(1500);});
    expect(updateSeat).toHaveBeenCalledTimes(1);
    expect(updateSeat).toHaveBeenCalledWith('committee', 'second', 2, {canVote: true, hasVeto: true, mustVote: false});
  });

  it('cancels queued changes on leaving setup', async () => {
    vi.useFakeTimers();
    const updateSeat = vi.fn() as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => value, {updateSeat});
    await act(async () => {clickSemanticCheckbox(page.querySelector('[aria-label="No abstention · All seats"]')?.parentElement);});
    act(() => {root?.unmount(); root = undefined;});
    await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
    expect(updateSeat).not.toHaveBeenCalled();
  });

  it('changes rank without changing capabilities', async () => {
    const updateSeat = vi.fn(async () => ({})) as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value,
      seats: [{...value.seats[0], rank: 'STANDARD', hasVeto: false, canVote: false},
        {...value.seats[0], id: 'second', rank: 'OBSERVER', hasVeto: false, canVote: false}]}), {updateSeat});
    expect(page.querySelector<HTMLInputElement>('[aria-label="No abstention · All seats"]')?.disabled).toBe(true);
    const dropdown = page.querySelector('[aria-label="Seat type · All seats"]')!;
    await act(async () => {(dropdown as HTMLElement).click();});
    const option = [...dropdown.querySelectorAll<HTMLElement>('.item')].find(item => item.textContent === 'NGO');
    expect(option).toBeTruthy();
    await act(async () => {option?.click();});
    expect(updateSeat).toHaveBeenCalledTimes(2);
    expect(updateSeat).toHaveBeenCalledWith('committee', 'seat', 2, {rank: 'NGO'});
    expect(updateSeat).toHaveBeenCalledWith('committee', 'second', 2, {rank: 'NGO'});
  });

  it('saves the final full combination after enabling veto, disabling voting and re-enabling voting', async () => {
    vi.useFakeTimers();
    const updateSeat = vi.fn(async () => ({})) as unknown as SelfHostedApi['updateSeat'];
    const page = await render('CHAIR', '/committees/committee/setup', user, value => ({...value,
      seats: [{...value.seats[0], rank: 'OBSERVER', canVote: false, hasVeto: false, mustVote: false}]}), {updateSeat});
    const click = async (label: string) => act(async () => {
      clickSemanticCheckbox(page.querySelector(`[aria-label="${label} · All seats"]`)?.parentElement);
    });
    await click('Veto');
    expect(page.querySelector<HTMLInputElement>('[aria-label="Voting · China"]')?.checked).toBe(true);
    await click('No abstention');
    await click('Voting');
    expect(page.querySelector<HTMLInputElement>('[aria-label="Veto · China"]')?.checked).toBe(false);
    expect(page.querySelector<HTMLInputElement>('[aria-label="No abstention · China"]')?.checked).toBe(false);
    await click('Voting');
    await act(async () => {await vi.advanceTimersByTimeAsync(1500);});
    expect(updateSeat).toHaveBeenCalledWith('committee', 'seat', 2, {canVote: true, hasVeto: false, mustVote: false});
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

  it('starts roll call when the Chair starts the meeting session', async () => {
    const startMeetingSession = vi.fn(async () => ({id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期',
      phaseId: 'formal-debate', activeRulePackageVersionId: 'rules', status: 'OPEN' as const, revision: 1,
      createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}));
    const startRollCall = vi.fn(async (): Promise<RollCall> => ({id: 'roll-call', committeeId: 'committee',
      meetingSessionId: 'meeting', status: 'IN_PROGRESS', currentSeatId: 'seat', rulePackageVersionId: 'rules',
      allowedResponses: ['PRESENT', 'ABSENT'], seats: [], entries: [], revision: 1, startedAt: '2026-08-14T00:00:00.000Z',
      completedAt: null}));
    const page = await render('CHAIR', '/committees/committee/roll-call', user, value => value,
      {startMeetingSession, startRollCall});

    await act(async () => {[...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start meeting')?.click(); await Promise.resolve(); await Promise.resolve();});

    expect(startMeetingSession).toHaveBeenCalledWith('committee');
    expect(startRollCall).toHaveBeenCalledWith('committee', 'meeting');
    expect(startRollCall.mock.invocationCallOrder[0]).toBeGreaterThan(startMeetingSession.mock.invocationCallOrder[0]);
  });

  it('automatically starts roll call for an already-open meeting session', async () => {
    const startRollCall = vi.fn(async (): Promise<RollCall> => ({id: 'roll-call', committeeId: 'committee',
      meetingSessionId: 'meeting', status: 'IN_PROGRESS', currentSeatId: 'seat', rulePackageVersionId: 'rules',
      allowedResponses: ['PRESENT', 'ABSENT'], seats: [], entries: [], revision: 1, startedAt: '2026-08-14T00:00:00.000Z',
      completedAt: null}));
    const page = await render('CHAIR', '/committees/committee/roll-call', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}),
      {startRollCall});
    await act(async () => {await Promise.resolve(); await Promise.resolve();});

    expect(startRollCall).toHaveBeenCalledWith('committee', 'meeting');
    expect(page.textContent).not.toContain('Start roll call');
  });

  it('restores the paged roll-call board and lets a Chair directly change any frozen seat', async () => {
    const setRollCallResponse = vi.fn(async (): Promise<RollCall> => ({id: 'roll-call', committeeId: 'committee',
      meetingSessionId: 'meeting', status: 'IN_PROGRESS', currentSeatId: 'seat-0', rulePackageVersionId: 'rules',
      allowedResponses: ['PRESENT', 'ABSENT'], seats: [], entries: [], revision: 4,
      startedAt: '2026-08-14T00:00:00.000Z', completedAt: null}));
    const seats = Array.from({length: 20}, (_, index) => ({id: `seat-${index}`, stableKey: `seat-${index}`,
      displayName: `Seat ${String(20 - index).padStart(2, '0')}`, rank: 'STANDARD' as const, canVote: true,
      hasVeto: false, mustVote: false, sortOrder: index, active: true, revision: 1,
      flag: {type: 'EMOJI' as const, value: index === 0 ? '🏳️' : '🌐'}}));
    const page = await render('CHAIR', '/committees/committee/roll-call', user, value => ({...value, seats: seats.slice(1),
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      rollCall: {id: 'roll-call', committeeId: 'committee', meetingSessionId: 'meeting', status: 'IN_PROGRESS',
        currentSeatId: 'seat-0', rulePackageVersionId: 'rules', allowedResponses: ['PRESENT', 'ABSENT'], seats: seats.map(({id, displayName, canVote, flag}) => ({id, displayName, canVote, flag})),
        entries: [{id: 'entry', seatId: 'seat-1', seatDisplayName: 'Seat 02', response: 'PRESENT', actorUserId: 'chair',
          onBehalfOfSeatId: 'seat-1', rulePackageVersionId: 'rules', recordedAt: '2026-08-14T00:00:00.000Z', revision: 1}],
        revision: 3, startedAt: '2026-08-14T00:00:00.000Z', completedAt: null}}), {setRollCallResponse});

    expect(page.querySelectorAll('.roll-call-grid .roll-call-member')).toHaveLength(9);
    expect(page.querySelector<HTMLButtonElement>('.roll-call-grid .roll-call-member')?.dataset.rollCallSeat).toBe('seat-0');
    expect(Array.from(page.querySelectorAll<HTMLButtonElement>('.roll-call-grid .roll-call-member'))
      .map(seat => seat.dataset.rollCallSeat)).toEqual(Array.from({length: 9}, (_, index) => `seat-${index}`));
    expect(page.textContent).toContain('1 of 20 called');
    expect(page.textContent).toContain('Now calling');
    expect(page.querySelector('.roll-call-current-name')?.textContent).toBe('Seat 20');
    expect(page.textContent).not.toContain('Present and voting');
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      points: [{id: 'point', committeeId: 'committee', meetingSessionId: 'meeting',
        typeNames: {en: 'Point of personal privilege', 'zh-CN': '个人特权问题'}, pointTypeId: 'point-of-personal-privilege', content: 'The room is too warm.', raisedBySeatId: 'seat',
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 2, name: '第2会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'PENDING', revision: 2,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}));

    expect(page.textContent).toContain('Open a meeting first.');
    expect(page.querySelector('.motions-empty-card')).not.toBeNull();
    expect(page.querySelector('.motions-empty-card-content')).not.toBeNull();
    expect(page.querySelector('.motions-empty-card a[href="/committees/committee/roll-call"]')?.textContent).toContain('Roll Call');
  });

  it.each(['suspend-meeting', 'adjourn-meeting'])('returns to the pending-session page after passing %s', async motionTypeId => {
    let sessionEnded = false;
    const motion: ProceedingMotion = {id: 'suspend', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId, proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China', parameters: {},
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
      meetingEndedAt: sessionEnded && motionTypeId === 'adjourn-meeting' ? '2026-08-14T00:01:00.000Z' : null,
      meetingSession: {id: sessionEnded ? 'next-meeting' : 'meeting', committeeId: 'committee',
        ordinal: sessionEnded ? 2 : 1, name: sessionEnded ? '第2会期' : '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: sessionEnded ? 'PENDING' : 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      motions: [{...motion, status: sessionEnded ? 'PASSED' : 'SECONDED'}],
      activeRules: {...value.activeRules, motionTypes: [{id: motionTypeId,
        names: motionTypeId === 'adjourn-meeting' ? {en: 'Adjourn the meeting', 'zh-CN': '休会'}
          : {en: 'Suspend the meeting', 'zh-CN': '暂停会议'},
        procedural: true, requiredSecondCount: 0}]}}), {decideMotion});

    const passed = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Passed');
    await act(async () => {passed?.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();});
    expect(decideMotion).toHaveBeenCalledWith('suspend', 1, 'PASSED');
    expect(page.querySelector('.motions-empty-card')?.textContent).toContain(
      motionTypeId === 'adjourn-meeting' ? 'Meeting ended' : 'Open a meeting first.');
    expect([...page.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Passed')).toBe(false);
    expect(page.querySelector('.motions-empty-card a[href="/committees/committee/roll-call"]')?.textContent).toContain('Roll Call');
  });

  it('allows starting the next session after adjournment and clears the ended notice', async () => {
    let started = false;
    const session = {id: 'next-meeting', committeeId: 'committee', ordinal: 2, name: '第2会期', phaseId: 'formal-debate',
      activeRulePackageVersionId: 'rules', status: 'OPEN' as const, revision: 2,
      createdAt: '2026-08-14T00:01:00.000Z', closedAt: null};
    const rollCall: RollCall = {id: 'roll-call', committeeId: 'committee', meetingSessionId: session.id,
      status: 'IN_PROGRESS', currentSeatId: 'seat', rulePackageVersionId: 'rules',
      allowedResponses: ['PRESENT', 'ABSENT'], seats: [], entries: [], revision: 1,
      startedAt: '2026-08-14T00:02:00.000Z', completedAt: null};
    const startMeetingSession = vi.fn(async () => {started = true; return session;});
    const startRollCall = vi.fn(async () => rollCall);
    const page = await render('CHAIR', '/committees/committee/roll-call', user, value => ({...value,
      meetingEndedAt: started ? null : '2026-08-14T00:01:00.000Z',
      meetingSession: {...session, status: started ? 'OPEN' : 'PENDING'},
      ...(started ? {rollCall} : {})}), {startMeetingSession, startRollCall});
    expect(page.textContent).toContain('Meeting ended');
    const start = page.querySelector<HTMLButtonElement>('.roll-call-start-card button');
    expect(start?.textContent).toBe('Start meeting');
    expect(start?.disabled).toBe(false);
    await act(async () => {start?.click();});
    expect(startMeetingSession).toHaveBeenCalledWith('committee');
    expect(startRollCall).toHaveBeenCalledWith('committee', session.id);
    expect(page.textContent).not.toContain('Meeting ended');
    expect(page.querySelector('.roll-call-start-card')).toBeNull();
  });

  it('links a passed formal-debate motion to the general speakers list', async () => {
    const motion: ProceedingMotion = {id: 'open-debate', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'open-debate', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China', parameters: {},
      status: 'PASSED', rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules',
        definition: {}, facts: {}, resolvedValues: {}, frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 0,
      seconds: [], revision: 1, directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1,
        eligibility: [], choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []},
      createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null,
      destinationPath: '/committees/committee/caucuses/general'};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}, motions: [motion],
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-debate', names: {en: 'Open formal debate'},
        procedural: true, requiredSecondCount: 0}]}}));

    const link = page.querySelector<HTMLAnchorElement>('.motion-queue a[href="/committees/committee/caucuses/general"]');
    expect(link?.textContent).toContain("General Speaker's List");
    expect(link?.classList.contains('primary')).toBe(true);
    expect(link?.classList.contains('fluid')).toBe(true);
    expect(link?.classList.contains('bottom')).toBe(true);
  });

  it('separates motion history at meeting-session boundaries', async () => {
    const sessions: NonNullable<CommitteeWorkspaceSnapshot['meetingSessions']> = [
      {id: 'session-2', committeeId: 'committee', ordinal: 2, name: '第2会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 2, createdAt: '2026-08-14T01:00:00.000Z', closedAt: null},
      {id: 'session-1', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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

  it.each(['PRESENT', 'ABSENT', 'TEMPORARILY_LEFT', undefined] as const)(
    'uses each motion session attendance when current attendance is %s', async currentState => {
    const createdAt = '2026-08-14T00:00:00.000Z';
    const sessions: NonNullable<CommitteeWorkspaceSnapshot['meetingSessions']> = [
      {id: 'current', committeeId: 'committee', ordinal: 3, name: 'Session 3', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt, closedAt: null},
      ...['previous', 'oldest'].map((id, index) => ({id, committeeId: 'committee', ordinal: 2 - index,
        name: `Session ${2 - index}`, phaseId: 'formal-debate', activeRulePackageVersionId: 'rules',
        status: 'CLOSED' as const, revision: 2, createdAt, closedAt: createdAt}))
    ];
    const attendance = (state: 'PRESENT' | 'ABSENT' | 'TEMPORARILY_LEFT') => ['seat', 'seconder'].map(seatId => ({
      seatId, state, lastEventId: `${state}-${seatId}`, updatedAt: createdAt}));
    const motions: ProceedingMotion[] = sessions.map(session => ({id: session.id, committeeId: 'committee',
      meetingSessionId: session.id, motionTypeId: 'suspend-meeting', proposedBySeatId: 'seat',
      proposedBySeatDisplayName: 'China', parameters: {}, status: 'PASSED', rulePackageVersionId: 'rules',
      ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {},
        frozenAt: createdAt}, requiredSecondCount: 1,
      seconds: [{id: `second-${session.id}`, seatId: 'seconder', seatDisplayName: 'Bahrain', createdAt}], revision: 1,
      directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1, eligibility: [],
        choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []},
      createdAt, decidedAt: null, destinationPath: null}));
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      seats: [...value.seats, {...value.seats[0], id: 'seconder', stableKey: 'bahrain', displayName: 'Bahrain'}],
      meetingSession: sessions[0], meetingSessions: sessions, motions,
      attendance: currentState ? attendance(currentState) : [],
      attendanceBySession: {previous: attendance('PRESENT'), oldest: attendance('ABSENT')}}));
    const cards = page.querySelectorAll('.motion-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelectorAll('.motion-metadata-value .label')).toHaveLength(currentState === 'PRESENT' ? 0 : 2);
    expect(cards[1].textContent).toContain('China');
    expect(cards[1].textContent).toContain('Bahrain');
    expect(cards[1].querySelectorAll('.motion-metadata-value .label')).toHaveLength(0);
    expect(cards[2].querySelectorAll('.motion-metadata-value .label')).toHaveLength(2);
  });

  it('separates point history at meeting-session boundaries', async () => {
    const sessions: NonNullable<CommitteeWorkspaceSnapshot['meetingSessions']> = [
      {id: 'session-2', committeeId: 'committee', ordinal: 2, name: '第2会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 2, createdAt: '2026-08-14T01:00:00.000Z', closedAt: null},
      {id: 'session-1', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'CLOSED', revision: 2, createdAt: '2026-08-14T00:00:00.000Z',
        closedAt: '2026-08-14T00:30:00.000Z'}
    ];
    const point = (id: string, meetingSessionId: string, createdAt: string): CommitteePoint => ({id, committeeId: 'committee',
      meetingSessionId, typeNames: {en: 'Point of order', 'zh-CN': '程序问题'}, pointTypeId: 'point-of-order', content: 'Order', raisedBySeatId: 'seat',
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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
    const proposeMotion = vi.fn(async () => ({} as ProceedingMotion));
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION',
        resolutionId: null, ordinal: 1, customTitle: null, title: 'New draft resolution 1', status: 'DRAFT', rulePackageVersionId: 'rules',
        currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'},
        votingVersionId: null, public: false, proposers: [], seconders: [], delegatesCanAmend: false,
        directVote: null, resultDecisions: [], revision: 1, discussion: [],
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}],
      activeRules: {...value.activeRules, motionTypes: [{id: 'introduce-draft-resolution',
        names: {en: 'Introduce draft resolution', 'zh-CN': '展示决议草案'}, procedural: true,
        requiredSecondCount: 0}]}}), {proposeMotion});
    expect(page.textContent).toContain('Target Draft Resolution');
    expect(page.textContent).toContain('New draft resolution 1');
    expect(page.textContent).not.toContain('Name');
    expect([...page.querySelectorAll('.motion-proposal-form label')].map(label => label.textContent)).not.toContain('Seconder');
    const proposer = page.querySelector<HTMLElement>('.motion-proposer-field .ui.dropdown');
    await act(async () => {proposer?.click(); await Promise.resolve();});
    await act(async () => {proposer?.querySelector<HTMLElement>('[role="option"]')?.click(); await Promise.resolve();});
    const target = [...page.querySelectorAll<HTMLElement>('.motion-proposal-form .field')]
      .find(field => field.querySelector('label')?.textContent === 'Target Draft Resolution')?.querySelector<HTMLElement>('.ui.dropdown');
    await act(async () => {target?.click(); await Promise.resolve();});
    await act(async () => {target?.querySelector<HTMLElement>('[role="option"]')?.click(); await Promise.resolve();});
    await act(async () => {page.querySelector<HTMLButtonElement>('button[aria-label="Propose motion"]')?.click(); await Promise.resolve();});
    expect(proposeMotion).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', motionTypeId: 'introduce-draft-resolution',
      onBehalfOfSeatId: 'seat', parameters: {resolutionTarget: 'resolution'}});
  });

  it('targets an existing amendment draft instead of creating one from the introduction motion', async () => {
    const baseDocument = {committeeId: 'committee', meetingSessionId: 'meeting', rulePackageVersionId: 'rules',
      votingVersionId: null, public: false, proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}], seconders: [], delegatesCanAmend: false,
      directVote: null, resultDecisions: [], revision: 1, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [
        {...baseDocument, id: 'resolution', kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'New draft resolution 1',
          status: 'PUBLISHED', public: true, currentVersion: {id: 'resolution-version', versionNumber: 1,
            content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}},
        {...baseDocument, id: 'amendment', kind: 'AMENDMENT', resolutionId: 'resolution', ordinal: 1, customTitle: null, title: 'New amendment 1',
          status: 'DRAFT', currentVersion: {id: 'amendment-version', versionNumber: 1,
            content: 'Replace clause 1', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}}
      ] as ProceedingDocument[],
      activeRules: {...value.activeRules, motionTypes: [{id: 'introduce-amendment',
        names: {en: 'Introduce amendment', 'zh-CN': '展示修正案'}, procedural: true, requiredSecondCount: 1}]}}));
    expect(page.textContent).toContain('Target Amendment');
    expect(page.textContent).toContain('New amendment 1');
    expect(page.textContent).not.toContain('Target Draft Resolution');
  });

  it.each([
    {status: 'PUBLISHED', debate: [] as string[], visible: ['Postpone Draft Resolution', 'Vote on Draft Resolution',
      'Introduce Amendment', 'Moderated Caucus - Draft A'], hidden: ['Resume the Draft Resolution']},
    {status: 'POSTPONED', debate: [] as string[], visible: ['Resume the Draft Resolution'],
      hidden: ['Postpone Draft Resolution', 'Vote on Draft Resolution', 'Introduce Amendment', 'Moderated Caucus - Draft A']},
    {status: 'PUBLISHED', debate: ['close-debate'], visible: ['Postpone Draft Resolution', 'Vote on Draft Resolution'],
      hidden: ['Introduce Amendment', 'Resume the Draft Resolution']},
    {status: 'PUBLISHED', debate: ['close-debate', 'open-debate'], visible: ['Introduce Amendment'],
      hidden: ['Resume the Draft Resolution']}
  ] as const)('filters resolution motions for $status after $debate', async ({status, debate, visible, hidden}) => {
    document.documentElement.lang = 'en';
    const base = {committeeId: 'committee', meetingSessionId: 'meeting', rulePackageVersionId: 'rules',
      votingVersionId: null, public: true, proposers: [], seconders: [], delegatesCanAmend: false, directVote: null,
      resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: 'Session 1', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      documents: [{...base, id: 'resolution', kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: 'Draft A',
        title: 'Draft A', status, currentVersion: {id: 'resolution-version', versionNumber: 1,
          content: 'Body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}},
      {...base, id: 'amendment', kind: 'AMENDMENT', resolutionId: 'resolution', ordinal: 1, customTitle: null,
        title: 'Amendment A', status: 'DRAFT', currentVersion: {id: 'amendment-version', versionNumber: 1,
          content: 'Replace clause', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}}] as ProceedingDocument[],
      motions: debate.map((motionTypeId, index) => ({id: `debate-${index}`, committeeId: 'committee',
        meetingSessionId: 'meeting', motionTypeId, proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
        parameters: {}, status: 'PASSED', rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1,
          packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {}, frozenAt: '2026-08-14T00:00:00.000Z'},
        requiredSecondCount: 0, seconds: [], directVote: {includeNonVotingSeats: false, startedAt: null,
          settingsRevision: 1, eligibility: [], choices: ['FOR', 'AGAINST'], threshold: 1,
          automaticResult: null, votes: []}, revision: 2, createdAt: '2026-08-14T00:00:00.000Z',
        decidedAt: `2026-08-14T00:0${index + 1}:00.000Z`, destinationPath: null})) as ProceedingMotion[],
      activeRules: {...value.activeRules, motionTypes: [
        {id: 'open-moderated-caucus', names: {en: 'Open Moderated Caucus'}, procedural: true, requiredSecondCount: 0},
        {id: 'postpone-resolution', names: {en: 'Postpone Draft Resolution'}, procedural: false, requiredSecondCount: 0},
        {id: 'resume-resolution', names: {en: 'Resume the Draft Resolution'}, procedural: false, requiredSecondCount: 0},
        {id: 'vote-on-resolution', names: {en: 'Vote on Draft Resolution'}, procedural: false, requiredSecondCount: 0},
        {id: 'introduce-amendment', names: {en: 'Introduce Amendment'}, procedural: false, requiredSecondCount: 0}
      ]}}));
    const options = [...page.querySelectorAll<HTMLElement>('.motion-proposal-form .field .menu .item')]
      .map(item => item.textContent?.trim());
    for (const label of visible) expect(options).toContain(label);
    for (const label of hidden) expect(options).not.toContain(label);
    if (status === 'PUBLISHED' && debate.length === 0) {
      const voteOption = [...page.querySelectorAll<HTMLElement>('.motion-proposal-form .field .menu .item')]
        .find(item => item.textContent?.trim() === 'Vote on Draft Resolution');
      await act(async () => {voteOption?.click(); await Promise.resolve();});
      const target = [...page.querySelectorAll<HTMLElement>('.motion-proposal-form .field')]
        .find(field => field.querySelector('label')?.textContent === 'Target Draft Resolution');
      expect(target?.querySelector('.menu .item .description')?.textContent).toBe('Not yet discussed');
    }
  });

  it('targets an introduced amendment from the formal-vote motion', async () => {
    const document = {committeeId: 'committee', meetingSessionId: 'meeting', rulePackageVersionId: 'rules',
      votingVersionId: null, public: true, proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}], seconders: [], delegatesCanAmend: false,
      directVote: null, resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{...document, id: 'resolution', kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null,
        title: 'Draft resolution 1', status: 'PUBLISHED', currentVersion: {id: 'resolution-version', versionNumber: 1,
          content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}},
      {...document, id: 'amendment', kind: 'AMENDMENT', resolutionId: 'resolution', ordinal: 1, customTitle: null,
        title: 'New amendment 1', status: 'PUBLISHED', currentVersion: {id: 'amendment-version', versionNumber: 1,
          content: 'Replace clause 1', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}}] as ProceedingDocument[],
      activeRules: {...value.activeRules, motionTypes: [{id: 'vote-on-amendment',
        names: {en: 'Vote on amendment', 'zh-CN': '对修正案投票'}, procedural: false, requiredSecondCount: 0}]}}));
    expect(page.textContent).toContain('Target Amendment');
    expect(page.textContent).toContain('New amendment 1');
    expect(page.textContent).not.toContain('Text');
  });

  it.each([
    ['en', 'Draft resolution 1.1', 'Discussion of Draft resolution 1.1'],
    ['zh-CN', '决议草案 1.1', '关于决议草案 1.1的讨论']
  ] as const)('keeps the %s resolution caucus option and fills its topic', async (language, title, topic) => {
    setLanguage(language);
    const motion: ProceedingMotion = {id: 'motion', committeeId: 'committee', meetingSessionId: 'meeting',
      motionTypeId: 'open-moderated-caucus', proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China',
      parameters: {proposal: topic, resolutionTarget: 'resolution', caucusDuration: 10, caucusUnit: 'min',
        speakerDuration: 1, speakerUnit: 'min'}, status: 'SECONDED', rulePackageVersionId: 'rules',
      ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {}, resolvedValues: {},
        frozenAt: '2026-08-14T00:00:00.000Z'}, requiredSecondCount: 0, seconds: [], revision: 1,
      directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1, eligibility: [],
        choices: ['FOR', 'AGAINST'], threshold: 1, automaticResult: null, votes: []},
      createdAt: '2026-08-14T00:00:00.000Z', decidedAt: null, destinationPath: null};
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      committee: {...value.committee, committeeLanguage: language}, motions: [motion],
      seats: [...value.seats, {id: 'seconder', stableKey: 'usa', displayName: 'United States', rank: 'STANDARD',
        canVote: true, hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1,
        flag: {type: 'STANDARD', value: 'us'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance-1',
        updatedAt: '2026-08-14T00:00:00.000Z'}, {seatId: 'seconder', state: 'PRESENT',
        lastEventId: 'attendance-2', updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION',
        resolutionId: null, ordinal: 1, customTitle: null, title, status: 'PUBLISHED', rulePackageVersionId: 'rules',
        currentVersion: {id: 'version', versionNumber: 1, content: 'Draft body', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: true,
        proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}], seconders: [{seatId: 'seconder', seatDisplayName: 'France', flag: {type: 'STANDARD', value: 'fr'}}], delegatesCanAmend: false, directVote: null,
        resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-moderated-caucus',
        names: {en: 'Open a moderated caucus', 'zh-CN': '开启有主持核心磋商'}, procedural: true,
        requiredSecondCount: 1}]}}));

    const optionLabel = `${language === 'zh-CN' ? '有主持核心磋商' : 'Moderated Caucus'} - ${title}`;
    expect(page.textContent).toContain(optionLabel);
    const option = [...page.querySelectorAll<HTMLElement>('.motion-proposal-form .menu .item')]
      .find(item => item.textContent?.includes(optionLabel));
    await act(async () => {option?.click(); await Promise.resolve();});
    expect(page.querySelector<HTMLInputElement>(`.motion-proposal-form input[placeholder="${language === 'zh-CN' ? '议题' : 'Topic'}"]`)?.value)
      .toBe(topic);
    const rows = [...page.querySelectorAll<HTMLTableRowElement>('.motion-card .motion-metadata-table tr')]
      .map(row => [row.cells[0]?.textContent, row.cells[1]?.textContent]);
    expect(rows).toEqual(expect.arrayContaining(language === 'zh-CN'
      ? [['总时长', '600秒'], ['单次发言时长', '60秒']]
      : [['Total duration', '600 sec'], ['Speaking time', '60 sec']]));
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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

  it('uses compact second-based time controls and permits clearing a motion duration', async () => {
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance', updatedAt: '2026-08-14T00:00:00.000Z'}],
      activeRules: {...value.activeRules, motionTypes: [{id: 'open-moderated-caucus',
        names: {en: 'Open a moderated caucus', 'zh-CN': '开启有主持核心磋商'}, procedural: true,
        requiredSecondCount: 0}]}}));

    expect([...page.querySelectorAll('.motion-proposal-form label')].map(label => label.textContent)).toEqual(
      expect.arrayContaining(['Topic', 'Proposer', 'Total duration', 'Speaking time']));
    expect([...page.querySelectorAll<HTMLInputElement>('.motion-time-value input')].map(input => input.value)).toEqual(['600', '60']);
    expect([...page.querySelectorAll<HTMLElement>('.motion-time-unit > .ui.dropdown > .text')].map(item => item.textContent)).toEqual(['sec', 'sec']);
    expect([...page.querySelectorAll<HTMLElement>('.motion-time-conversion')].map(item => item.textContent)).toEqual(['10 min', '1 min']);
    const duration = page.querySelector<HTMLInputElement>('.motion-time-value input');
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(duration, '');
      duration?.dispatchEvent(new Event('input', {bubbles: true})); await Promise.resolve();});
    expect(duration?.value).toBe('');
    expect(page.querySelector<HTMLButtonElement>('button[aria-label="Propose motion"]')?.disabled).toBe(true);
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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
      .map(button => button.textContent?.trim())).toEqual(['Passed', 'Failed']);
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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

    expect(page.querySelector('.motion-ballot-panel')?.textContent).toContain('Formal Ballot');
    expect(page.querySelector('.motion-ballot-panel')?.textContent).toContain('China: For');
    const stop = page.querySelector<HTMLButtonElement>('.motion-stop-voting');
    expect(stop?.textContent?.trim()).toBe('Stop voting');
    expect(stop?.classList.contains('negative')).toBe(true);
    await act(async () => {stop?.click(); await Promise.resolve();});
    expect(closeBallot).toHaveBeenCalledWith('ballot', 3);

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const castVote = vi.fn(async () => ({} as never));
    for (const audience of ['CHAIR', 'MEMBER'] as const) {
      const frozenPage = await render(audience, '/committees/committee/motions', user, value => {
        const next = customize(value);
        return {...next, seats: [{...value.seats[0], displayName: 'Renamed current seat', canVote: false, hasVeto: false, mustVote: false},
          {...value.seats[0], id: 'new-seat', displayName: 'New seat'}],
          ballots: next.ballots!.map(ballot => ({...ballot, votes: [],
            eligibility: [{seatId: 'seat', seatDisplayName: 'Frozen China', mustVote: true, hasVeto: true}]}))};
      }, {castVote});
      const panel = frozenPage.querySelector('.motion-ballot-panel')!;
      expect(panel.textContent).toContain('Veto');
      expect(panel.textContent).not.toContain('New seat');
      expect([...panel.querySelectorAll('button')].some(button => button.textContent === 'Abstain')).toBe(false);
      const forButton = [...panel.querySelectorAll('button')].find(button => button.textContent === 'For');
      expect(forButton).toBeTruthy();
      await act(async () => {forButton!.click();});
      expect(castVote).toHaveBeenLastCalledWith('ballot', 'FOR', audience === 'CHAIR' ? 'seat' : undefined);
      act(() => root?.unmount()); root = undefined; frozenPage.remove(); container = undefined;
    }
    const chairOperatedPage = await render('CHAIR', '/committees/committee/motions', user, value => ({...customize(value),
      committee: {...value.committee, operationMode: 'CHAIR_OPERATED'}}), {closeBallot});
    expect(chairOperatedPage.querySelector('.motion-ballot-panel')).toBeNull();
    expect(chairOperatedPage.querySelector('.motion-stop-voting')).toBeNull();
    expect([...chairOperatedPage.querySelectorAll<HTMLButtonElement>('.motion > .buttons button')]
      .map(button => button.textContent?.trim())).toEqual(['Passed', 'Failed']);
  });

  it('redirects the legacy caucus route into the moderated-caucus modal and creates from second defaults', async () => {
    const createSpeakerList = vi.fn(async () => ({id: 'created'} as SpeakerList));
    await render('CHAIR', '/committees/committee/caucuses/new', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}), {createSpeakerList});
    await act(async () => {await Promise.resolve(); await Promise.resolve();});
    const modal = document.querySelector('.moderated-caucus-create-modal');
    const topic = modal?.querySelector<HTMLInputElement>('input:not([inputmode="decimal"])');
    const durations = modal?.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]');
    const submit = modal?.querySelector<HTMLButtonElement>('button.primary');
    expect(topic?.closest('.field')?.textContent).toContain('Topic');
    expect(Array.from(durations ?? []).map(input => input.value)).toEqual(['60', '600']);
    expect(submit?.disabled).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(topic, 'Climate finance');
      topic?.dispatchEvent(new Event('input', {bubbles: true}));
      await Promise.resolve();
    });
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(durations?.[1], '601');
      durations?.[1]?.dispatchEvent(new Event('input', {bubbles: true}));
      await Promise.resolve();
    });
    expect(durations?.[1]?.closest('.field')?.classList.contains('error')).toBe(false);
    expect(submit?.disabled).toBe(true);
    await act(async () => {durations?.[1]?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));});
    expect(durations?.[1]?.closest('.field')?.classList.contains('error')).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(durations?.[1], '600');
      durations?.[1]?.dispatchEvent(new Event('input', {bubbles: true}));
      await Promise.resolve();
    });
    await act(async () => {
      modal?.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
      await Promise.resolve(); await Promise.resolve();
    });

    expect(createSpeakerList).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', kind: 'MODERATED_CAUCUS', customTitle: null,
      topic: 'Climate finance', defaultSpeechMs: 60_000, totalDurationMs: 600_000});
  });

  it('shows static second units and rejects duration precision beyond two decimal places', async () => {
    await render('CHAIR', '/committees/committee/caucuses/new', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}));
    await act(async () => {await Promise.resolve(); await Promise.resolve();});
    const modal = document.querySelector('.moderated-caucus-create-modal');
    const input = modal?.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
    expect(modal?.querySelector('.ui.dropdown')).toBeNull();
    expect(Array.from(modal?.querySelectorAll('.moderated-caucus-duration-unit-text') ?? [])
      .map(unit => unit.textContent)).toEqual(['sec', 'sec']);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '0.333');
      input?.dispatchEvent(new Event('input', {bubbles: true})); await Promise.resolve();
    });
    expect(input?.closest('.field')?.classList.contains('error')).toBe(false);
    expect(modal?.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true);
    await act(async () => {input?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));});
    expect(input?.closest('.field')?.classList.contains('error')).toBe(true);
  });

  it('keeps the moderated-caucus modal open after a dimmer click and explains how to close it', async () => {
    const page = await render('CHAIR', '/committees/committee/motions', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}));
    const createItem = [...page.querySelectorAll<HTMLElement>('.committee-primary-navigation .dropdown .item')]
      .find(item => item.textContent?.includes('New Moderated Caucus'));
    await act(async () => {createItem?.click(); await Promise.resolve();});
    const dimmer = document.querySelector<HTMLElement>('.moderated-caucus-create-modal')?.parentElement;
    act(() => dimmer?.dispatchEvent(new MouseEvent('click', {bubbles: true})));
    expect(document.querySelector('.moderated-caucus-create-modal')?.textContent)
      .toContain('To close the dialog, click "X".');
    expect(document.querySelector('.moderated-caucus-create-header .moderated-caucus-create-close')).not.toBeNull();
  });

  it('shows an agenda field only on the general speakers list', async () => {
    const withList = (value: CommitteeWorkspaceSnapshot, kind: 'GENERAL' | 'MODERATED_CAUCUS') => ({...value,
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind, customTitle: null, status: 'OPEN' as const,
        name: kind === 'GENERAL' ? "General Speakers' List" : 'Climate finance', topic: 'Climate finance',
        defaultSpeechMs: 60_000, delegatesCanQueue: false, rulePackageVersionId: 'rules', currentEntryId: null,
        speechTimerId: 'speech-timer', totalTimerId: kind === 'MODERATED_CAUCUS' ? 'total-timer' : null,
        linkedResolutionId: null, revision: 1, queue: [], speeches: [],
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}]});
    const general = await render('CHAIR', '/committees/committee/caucuses/list', user,
      value => withList(value, 'GENERAL'));
    expect(general.querySelector<HTMLTextAreaElement>('textarea')?.placeholder).toBe('Set agenda');

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const updateSpeakerList = vi.fn(async () => ({id: 'list'} as SpeakerList));
    const moderated = await render('CHAIR', '/committees/committee/caucuses/list', user,
      value => withList(value, 'MODERATED_CAUCUS'), {updateSpeakerList});
    expect(moderated.querySelector('textarea')).toBeNull();
    const name = moderated.querySelector<HTMLInputElement>('input[placeholder="Set Moderated Caucus name"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'International finance');
      name?.dispatchEvent(new Event('input', {bubbles: true}));
      name?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(updateSpeakerList).toHaveBeenCalledWith('list', 1,
      {customTitle: 'International finance', topic: 'International finance'});
  });

  it('distinguishes an unopened general speakers list from one that was closed', async () => {
    const closedGeneralList = (value: CommitteeWorkspaceSnapshot) => ({...value, speakerLists: [{id: 'list',
      committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL' as const, customTitle: null, status: 'CLOSED' as const,
      name: "General Speakers' List", topic: '', defaultSpeechMs: 60_000, delegatesCanQueue: true,
      rulePackageVersionId: 'rules', currentEntryId: null, speechTimerId: 'speech-timer', totalTimerId: null,
      linkedResolutionId: null, revision: 1, queue: [], speeches: [], createdAt: '2026-08-14T00:00:00.000Z',
      closedAt: '2026-08-14T00:00:00.000Z'}]});
    const unopened = await render('CHAIR', '/committees/committee/caucuses/list', user, closedGeneralList);
    expect(unopened.textContent).toContain("The General Speaker's List has not been opened yet");
    expect(unopened.querySelector('.legacy-speaker-workspace .ui.dropdown')?.textContent).toContain('Close');

    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const closed = await render('CHAIR', '/committees/committee/caucuses/list', user, value => ({...closedGeneralList(value),
      motions: [{id: 'close-debate', committeeId: 'committee', meetingSessionId: 'meeting', motionTypeId: 'close-debate',
        proposedBySeatId: 'seat', proposedBySeatDisplayName: 'China', parameters: {}, status: 'PASSED' as const,
        rulePackageVersionId: 'rules', ruleEvaluation: {schemaVersion: 1, packageVersionId: 'rules', definition: {}, facts: {},
          resolvedValues: {}, frozenAt: '2026-08-14T00:01:00.000Z'}, requiredSecondCount: 0, seconds: [], revision: 1,
        directVote: {includeNonVotingSeats: false, startedAt: null, settingsRevision: 1, eligibility: [], choices: ['FOR', 'AGAINST'],
          threshold: 1, automaticResult: null, votes: []}, createdAt: '2026-08-14T00:01:00.000Z',
        decidedAt: '2026-08-14T00:01:00.000Z', destinationPath: null}]}));
    expect(closed.textContent).toContain("The General Speaker's List is closed");
  });

  it('shows current, next, timers, and queue only for the selected speaker list route', async () => {
    const page = await render('CHAIR', '/committees/committee/caucuses/list', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL', customTitle: null, status: 'OPEN',
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
          speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'}], speeches: [{id: 'completed-speech', speakerListId: 'list',
          queueEntryId: 'current', seatId: 'seat', seatDisplayName: 'China', kind: 'ORIGINAL', status: 'PAUSED',
          inheritedFromSpeechId: null, inheritedTimeMs: null, canYield: true, yieldType: null, yieldTargetSeatId: null,
          yieldDecisionStatus: null, interactionTargetSeatId: null, revision: 1, startedAt: '2026-08-14T00:00:00.000Z',
          endedAt: null, actions: [], contributions: []}], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST', ownerId: 'list', running: false,
        startedAt: null, remainingAtStartMs: 60_000, remainingMs: 60_000, revision: 1, expiredAt: null,
        serverTime: '2026-08-14T00:00:00.000Z'}]}));
    expect(page.textContent).toContain('Now speaking');
    expect(page.textContent).toContain('Next speaker');
    expect(page.textContent).toContain('China');
    expect(page.textContent).toContain('France');
    expect(page.textContent).not.toContain('Motion type');
    expect((page.textContent ?? '').indexOf('Queue')).toBeLessThan((page.textContent ?? '').indexOf('Next speaker'));
    const nextPanel = [...page.querySelectorAll<HTMLElement>('.ui.segment')]
      .find(segment => segment.querySelector('.top.left.attached.label')?.textContent === 'Next speaker');
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
    expect(speakerTimer?.querySelector('.speaker-timer-actions')?.textContent).toContain('Continue');
    expect(speakerTimer?.querySelector('.speaker-timer-actions')?.textContent).toContain('Next');
    const dividerNavigation = queuePanel?.querySelector('.speaker-queue-divider-navigation');
    expect(dividerNavigation?.querySelectorAll('a')).toHaveLength(2);
    expect(dividerNavigation?.textContent).toContain('Motions');
    expect(dividerNavigation?.textContent).toContain('Question');
    expect(dividerNavigation?.querySelector('a[href="/committees/committee/points"]')).not.toBeNull();
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL', customTitle: null, status: 'OPEN',
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
    expect(page.textContent).toContain('may ask a question');
    expect(page.textContent).toContain('Interaction recorded.');
    await act(async () => {await vi.advanceTimersByTimeAsync(9_999);});
    expect(page.textContent).toContain('Interaction recorded.');
    await act(async () => {await vi.advanceTimersByTimeAsync(1);});
    expect(page.querySelectorAll('.speaker-message-fade')).toHaveLength(2);
    await act(async () => {await vi.advanceTimersByTimeAsync(180);});
    expect(page.textContent).not.toContain('Interaction recorded.');
    expect(page.textContent).not.toContain('may ask a question');
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
    expect(page.textContent).toContain('Request failed. Try again later.');
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
      meetingSessionId: 'meeting', kind: 'MODERATED_CAUCUS', customTitle: null, status: 'OPEN', name: 'Climate finance',
      topic: 'Climate finance', defaultSpeechMs: 60_000, delegatesCanQueue: false, rulePackageVersionId: 'rules',
      currentEntryId: 'current', speechTimerId: 'speech-timer', totalTimerId: 'total-timer', linkedResolutionId: null, revision: 3,
      queue: [], speeches: [], createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}));
    const page = await render('CHAIR', '/committees/committee/caucuses/list', user, value => ({...value,
      layoutSettings: {moveQueueUp: true, timersInSeparateColumns: true},
      seats: [...value.seats, {id: 'france', stableKey: 'france', displayName: 'France', rank: 'STANDARD', canVote: true,
        hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1, flag: {type: 'STANDARD', value: 'fr'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'a', updatedAt: '2026-08-14T00:00:00.000Z'},
        {seatId: 'france', state: 'PRESENT', lastEventId: 'b', updatedAt: '2026-08-14T00:00:00.000Z'}],
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'MODERATED_CAUCUS', customTitle: null,
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
      .find(segment => segment.querySelector('.top.left.attached.label')?.textContent === 'Next speaker');
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
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN' as const, revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'GENERAL' as const, customTitle: null,
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

  it('keeps absent countries visible but disabled in general and moderated speaker queues', async () => {
    const withList = (value: CommitteeWorkspaceSnapshot, kind: 'GENERAL' | 'MODERATED_CAUCUS'): CommitteeWorkspaceSnapshot => ({...value,
      seats: [...value.seats, {id: 'france', stableKey: 'france', displayName: 'France', rank: 'STANDARD', canVote: true,
        hasVeto: false, mustVote: false, sortOrder: 1, active: true, revision: 1, flag: {type: 'STANDARD', value: 'fr'}}],
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'present', updatedAt: '2026-08-14T00:00:00.000Z'},
        {seatId: 'france', state: 'ABSENT', lastEventId: 'absent', updatedAt: '2026-08-14T00:00:00.000Z'}],
      speakerLists: [{id: 'list', committeeId: 'committee', meetingSessionId: 'meeting', kind, customTitle: null, status: 'OPEN',
        name: kind === 'GENERAL' ? "General Speakers' List" : 'Climate finance', topic: '', defaultSpeechMs: 60_000,
        delegatesCanQueue: false, rulePackageVersionId: 'rules', currentEntryId: null, speechTimerId: 'speech-timer',
        totalTimerId: kind === 'MODERATED_CAUCUS' ? 'total-timer' : null, linkedResolutionId: null, revision: 2,
        queue: [{id: 'france-entry', seatId: 'france', seatDisplayName: 'France', position: 1, status: 'QUEUED' as const,
          stance: 'NEUTRAL' as const, speechDurationMs: 60_000, createdAt: '2026-08-14T00:00:00.000Z'}], speeches: [],
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}],
      timers: [{id: 'speech-timer', committeeId: 'committee', ownerType: 'SPEAKER_LIST', ownerId: 'list', running: false,
        startedAt: null, remainingAtStartMs: 60_000, remainingMs: 60_000, revision: 1, expiredAt: null,
        serverTime: '2026-08-14T00:00:00.000Z'}, ...(kind === 'MODERATED_CAUCUS' ? [{id: 'total-timer', committeeId: 'committee',
        ownerType: 'CAUCUS' as const, ownerId: 'list', running: false, startedAt: null, remainingAtStartMs: 600_000,
        remainingMs: 600_000, revision: 1, expiredAt: null, serverTime: '2026-08-14T00:00:00.000Z'}] : [])]
    });

    for (const kind of ['GENERAL', 'MODERATED_CAUCUS'] as const) {
      const removeSpeakerQueueEntry = vi.fn(async () => ({id: 'list'} as SpeakerList));
      const page = await render('CHAIR', '/committees/committee/caucuses/list', user, value => withList(value, kind),
        {removeSpeakerQueueEntry});
      const dropdown = page.querySelector<HTMLElement>('.speaker-seat-dropdown .ui.dropdown');
      await act(async () => {dropdown?.click(); await Promise.resolve();});
      const absent = document.body.querySelector<HTMLElement>('.speaker-seat-dropdown-portal [role="option"]:nth-child(2)');
      expect(absent?.textContent).toContain('France');
      expect(absent?.textContent).toContain('Absent');
      expect(absent).toMatchObject({className: expect.stringContaining('disabled')});
      expect(absent?.getAttribute('aria-disabled')).toBe('true');
      await act(async () => {absent?.click(); await Promise.resolve();});
      expect(dropdown?.getAttribute('aria-expanded')).toBe('true');
      const stage = page.querySelector<HTMLElement>('.speaker-absent-action-blocker');
      expect(stage?.textContent).toContain('Prepare next speaker');
      await act(async () => {stage?.click(); await Promise.resolve();});
      expect(page.textContent).toContain('Remove the absent delegation before continuing.');
      const unavailableDrag = page.querySelector<HTMLElement>('.speaker-drag-handle-disabled');
      expect(unavailableDrag).not.toBeNull();
      await act(async () => {unavailableDrag?.click(); await Promise.resolve();});
      const remove = [...page.querySelectorAll<HTMLButtonElement>('.speaker-queue-feed button')]
        .find(button => button.textContent === 'Remove');
      await act(async () => {remove?.click(); await Promise.resolve();});
      expect(removeSpeakerQueueEntry).toHaveBeenCalledWith('list', 'france-entry', 2);
      act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    }
  });

  it('persists both legacy workspace layout switches as one revisioned setting command', async () => {
    const setLayoutSettings = vi.fn(async () => ({moveQueueUp: true, timersInSeparateColumns: true, revision: 5}));
    const page = await render('CHAIR', '/committees/committee/settings', user, value => ({...value,
      layoutSettings: {moveQueueUp: false, timersInSeparateColumns: true}
    }), {setLayoutSettings});
    const queueSwitch = [...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(input => input.closest('.checkbox')?.textContent?.includes("Show 'Queue' above 'Next speaker'"));
    expect(queueSwitch).toMatchObject({checked: false, disabled: false});

    await act(async () => {clickSemanticCheckbox(queueSwitch); await Promise.resolve(); await Promise.resolve();});
    expect(setLayoutSettings).toHaveBeenCalledWith('committee',
      {moveQueueUp: true, timersInSeparateColumns: true}, 4);
  });

  it('creates a system-named strawpoll immediately from the plus route', async () => {
    const created: CreatedStrawpoll = {id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1,
      question: 'New strawpoll 1', votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN',
      stage: 'PREPARING', medium: 'LINK', optionsArePublic: false, seriesId: 'poll', roundNumber: 1,
      supersededById: null, options: [], seatVotes: [], revision: 1,
      createdAt: '2026-08-14T00:00:00.000Z', closedAt: null};
    const createStrawpoll = vi.fn(async () => created);
    await render('CHAIR', '/committees/committee/strawpolls/new', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}), {createStrawpoll});
    expect(createStrawpoll).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', question: '',
      votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, options: [], medium: 'LINK', optionsArePublic: false});
  });

  it('submits an anonymous strawpoll once and locks every answer afterward', async () => {
    const voteStrawpoll = vi.fn(async (): Promise<Strawpoll> => ({} as Strawpoll));
    const page = await render('MEMBER', '/committees/committee/strawpolls/poll', user, value => ({...value,
      strawpolls: [{id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1, question: 'Preferred option?',
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
      strawpolls: [{id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1, question: 'Preferred option?',
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

  it.each([false, true])('serializes manual tally changes before results (failure=%s)', async fails => {
    let poll: Strawpoll = {id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1, question: 'Count?',
      votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN', stage: 'VOTING', medium: 'MANUAL',
      optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null,
      options: [{id: 'one', label: 'A', sortOrder: 0, voteCount: 0}, {id: 'two', label: 'B', sortOrder: 1, voteCount: 0}],
      seatVotes: [], revision: 4, createdAt: '2026-08-14T00:00:00.000Z', closedAt: null};
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const setStrawpollManualTally = vi.fn<SelfHostedApi['setStrawpollManualTally']>(async (_id, revision, optionId, count) => {
      await pending;
      if (fails) throw new Error('unavailable');
      expect(revision).toBe(poll.revision);
      poll = {...poll, revision: revision + 1, options: poll.options.map(option => option.id === optionId ? {...option, voteCount: count} : option)};
      return poll;
    });
    const commandStrawpollStage = vi.fn<SelfHostedApi['commandStrawpollStage']>(async (_id, revision) => {
      expect(revision).toBe(6); poll = {...poll, revision: 7, stage: 'RESULTS'}; return poll;
    });
    const page = await render('CHAIR', '/committees/committee/strawpolls/poll', user,
      value => ({...value, strawpolls: [poll]}), {setStrawpollManualTally, commandStrawpollStage});
    const edit = async (id: string, value: string) => {
      const input = page.querySelector<HTMLInputElement>(`[data-strawpoll-manual="${id}"] input`)!;
      await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));});
    };
    await edit('one', '8'); await edit('two', '7');
    expect(setStrawpollManualTally).toHaveBeenCalledTimes(1);
    expect(page.querySelector<HTMLInputElement>('[data-strawpoll-manual="two"] input')?.value).toBe('7');
    await act(async () => [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'View results')!.click());
    expect(commandStrawpollStage).not.toHaveBeenCalled();
    await act(async () => {release(); await pending;});
    if (fails) {
      expect(commandStrawpollStage).not.toHaveBeenCalled();
      expect(page.querySelector<HTMLInputElement>('[data-strawpoll-manual="one"] input')?.value).toBe('8');
      expect(page.querySelector<HTMLInputElement>('[data-strawpoll-manual="two"] input')?.value).toBe('7');
    } else {
      expect(setStrawpollManualTally.mock.calls).toEqual([['poll', 4, 'one', 8], ['poll', 5, 'two', 7]]);
      expect(commandStrawpollStage).toHaveBeenCalledWith('poll', 6, 'VIEW_RESULTS');
      expect(page.textContent).toContain('8 votes'); expect(page.textContent).toContain('7 votes');
    }
  });

  it('keeps manual tallies and the legacy results progress view separate from linked voting', async () => {
    const setStrawpollManualTally = vi.fn(async (): Promise<Strawpoll> => ({} as Strawpoll));
    const manual: Strawpoll = {id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1, question: 'Count?',
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
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null,
        title: 'Climate resolution', status: 'PUBLISHED', rulePackageVersionId: 'rules', currentVersion: {id: 'version',
          versionNumber: 1, content: 'Operative text', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
        public: true, proposers: [], seconders: [], delegatesCanAmend: false,
        directVote: {majority: 'SIMPLE_MAJORITY', startedAt: null, settingsRevision: 1, eligibility: [], threshold: 0,
          automaticResult: null, votes: []}, resultDecisions: [], revision: 2, discussion: [],
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}]}));
    expect(page.textContent).toContain('Text');
    expect(page.textContent).toContain('Amendments');
    expect(page.textContent).toContain('Voting');
    expect(page.textContent).not.toContain('Feed');
    expect(page.querySelector('.resolution-content-source .active.button')?.textContent).toBe('File');
    await act(async () => {page.querySelectorAll<HTMLButtonElement>('.resolution-content-source button')[1].click();});
    expect(page.textContent).toContain('Operative text');
    await act(async () => {page.querySelector<HTMLAnchorElement>('a[href="/committees/committee/resolutions/resolution/voting"]')?.click();});
    expect(page.textContent).toContain('No eligible delegations');
    expect(page.querySelector('.metric-simple strong')?.textContent).toBe('—');
    expect(page.querySelector('.metric-two-thirds strong')?.textContent).toBe('—');
    expect(page.querySelector('.resolution-result')).toBeNull();
  });

  it('restores the legacy amendment cards, immediate plus, and guarded trash action', async () => {
    const createAmendment = vi.fn(async (): Promise<ProceedingDocument> => ({} as ProceedingDocument));
    const deleteAmendment = vi.fn(async () => ({id: 'amendment', deleted: true as const}));
    const resolution: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'New draft resolution 1', status: 'PUBLISHED',
      rulePackageVersionId: 'rules', currentVersion: {id: 'resolution-version', versionNumber: 1,
        content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
      public: true, proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}], seconders: [], delegatesCanAmend: false, directVote: null,
      resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const amendment: ProceedingDocument = {...resolution, id: 'amendment', kind: 'AMENDMENT',
      resolutionId: 'resolution', ordinal: 1, customTitle: null, title: 'New amendment 1', status: 'DRAFT', public: false,
      currentVersion: {id: 'amendment-version', versionNumber: 1, content: 'Replace clause 1', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, revision: 1};
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/amendments', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null},
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}], documents: [resolution, amendment]}),
    {createAmendment, deleteAmendment});
    expect(page.querySelectorAll('.amendment-card')).toHaveLength(1);
    expect([...page.querySelectorAll<HTMLInputElement>('.amendment-card input')]
      .some(input => input.value === 'New amendment 1')).toBe(true);
    expect(page.textContent).toContain('Replace clause 1');
    const add = page.querySelector<HTMLButtonElement>('button[aria-label="Create Amendment"]');
    await act(async () => {add?.click(); await Promise.resolve();});
    expect(createAmendment).toHaveBeenCalledWith('resolution',
      {meetingSessionId: 'meeting', customTitle: null, content: '', onBehalfOfSeatId: 'seat'});
    const trash = page.querySelector<HTMLButtonElement>('.amendment-card button[aria-label="Delete"]');
    expect(trash?.disabled).toBe(false);
    await act(async () => {trash?.click(); await Promise.resolve();});
    expect(deleteAmendment).toHaveBeenCalledWith('amendment', 1);
  });

  it('opens and embeds the retained formal ballot from a voting amendment card', async () => {
    const createBallot = vi.fn(async () => ({}));
    const resolution: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'New draft resolution 1', status: 'PUBLISHED',
      rulePackageVersionId: 'rules', currentVersion: {id: 'resolution-version', versionNumber: 1,
        content: 'Resolution body', contentFile: null, createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null,
      public: true, proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}], seconders: [], delegatesCanAmend: false, directVote: null,
      resultDecisions: [], revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const amendment: ProceedingDocument = {...resolution, id: 'amendment', kind: 'AMENDMENT',
      resolutionId: 'resolution', ordinal: 1, customTitle: null, title: 'New amendment 1', status: 'VOTING', votingVersionId: 'amendment-version',
      currentVersion: {id: 'amendment-version', versionNumber: 1, content: 'Replace clause 1', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, revision: 3};
    const base = (value: CommitteeWorkspaceSnapshot) => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
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
    expect(ballotPage.textContent).toContain('Formal Ballot');
    expect(ballotPage.textContent).toContain('For');
    expect(ballotPage.textContent).toContain('Against');
  });

  it('creates an empty, system-named draft immediately from the resolution plus route', async () => {
    const created: ProceedingDocument = {id: 'created-resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'New draft resolution 1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: false, proposers: [],
      seconders: [], delegatesCanAmend: false, directVote: null, resultDecisions: [], revision: 1,
      discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    const createResolution = vi.fn(async () => created);
    await render('CHAIR', '/committees/committee/resolutions/new', user, value => ({...value,
      meetingSession: {id: 'meeting', committeeId: 'committee', ordinal: 1, name: '第1会期', phaseId: 'formal-debate',
        activeRulePackageVersionId: 'rules', status: 'OPEN', revision: 1,
        createdAt: '2026-08-14T00:00:00.000Z', closedAt: null}}), {createResolution});
    expect(createResolution).toHaveBeenCalledTimes(1);
    expect(createResolution).toHaveBeenCalledWith('committee', {meetingSessionId: 'meeting', customTitle: null, content: ''});
  });

  it.each(['RESOLUTION', 'AMENDMENT'] as const)('selects only published files and binds without uploading for %s', async kind => {
    const document: ProceedingDocument = {id: kind === 'RESOLUTION' ? 'resolution' : 'amendment', committeeId: 'committee', meetingSessionId: 'meeting',
      kind, resolutionId: kind === 'AMENDMENT' ? 'resolution' : null, ordinal: 1, customTitle: null, title: 'New draft resolution 1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: false, proposers: [],
      seconders: [], delegatesCanAmend: false, directVote: null, resultDecisions: [], revision: 1,
      discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    const uploadedFile = {id: 'file', committeeId: 'committee', logicalName: 'draft.pdf', mediaType: 'application/pdf',
      status: 'PUBLISHED' as const, syncState: 'SYNCED' as const, createdByUserId: 'user',
      currentVersion: {id: 'file-version', versionNumber: 1, originalName: 'draft.pdf', mediaType: 'application/pdf',
        sizeBytes: 4, sha256: 'a'.repeat(64), blobId: 'blob', createdAt: '2026-08-14T00:00:00.000Z'},
      revision: 1, submittedAt: null, publishedAt: null, createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'};
    const createFileUpload = vi.fn(async () => ({id: 'upload'} as never));
    const uploadFileContent = vi.fn(async () => ({id: 'upload'} as never));
    const commitFileUpload = vi.fn(async () => uploadedFile);
    const createDocumentVersion = vi.fn(async () => document).mockRejectedValueOnce(new Error('Save failed'));
    const page = await render('CHAIR', `/committees/committee/resolutions/resolution/${kind === 'RESOLUTION' ? 'text' : 'amendments'}`, user,
      value => ({...value, documents: kind === 'RESOLUTION' ? [document] : [{...document, id: 'resolution', kind: 'RESOLUTION', resolutionId: null, status: 'PUBLISHED'}, document]}), {listFiles: vi.fn(async () => [uploadedFile, ...(['PENDING_REVIEW', 'REJECTED', 'DELETED'] as const).map(status => ({...uploadedFile, id: status, logicalName: status, status})), {...uploadedFile, id: 'foreign', logicalName: 'foreign', committeeId: 'other'}]), createFileUpload,
        uploadFileContent, commitFileUpload, createDocumentVersion});

    const fileMode = kind === 'RESOLUTION' ? page.querySelectorAll<HTMLButtonElement>('.resolution-content-source button')[0]
      : [...page.querySelectorAll<HTMLButtonElement>('.amendment-card button')].find(button => button.textContent === 'File');
    await act(async () => {fileMode?.click(); await Promise.resolve();});
    expect(page.querySelector('input[type="file"]')).toBeNull();
    const selector = page.querySelector<HTMLElement>('.resolution-file-body .ui.dropdown');
    expect(selector?.textContent).toContain('draft.pdf');
    for (const name of ['PENDING_REVIEW', 'REJECTED', 'DELETED', 'foreign']) expect(selector?.textContent).not.toContain(name);
    let attach = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Use this file');
    expect(attach?.disabled).toBe(true);
    await act(async () => {selector?.click(); await Promise.resolve();});
    await act(async () => {selector?.querySelector<HTMLElement>('.menu .item')?.click(); await Promise.resolve();});
    attach = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Use this file');
    await act(async () => {attach?.click(); attach?.click(); for (let index = 0; index < 8; index += 1) await Promise.resolve();});
    expect(createFileUpload).not.toHaveBeenCalled();
    expect(uploadFileContent).not.toHaveBeenCalled();
    expect(commitFileUpload).not.toHaveBeenCalled();
    expect(createDocumentVersion).toHaveBeenCalledTimes(1);
    expect(createDocumentVersion).toHaveBeenCalledWith(document.id, {baseRevision: 1,
      customTitle: null, content: '', contentFileEntryId: 'file', onBehalfOfSeatId: 'seat'});
    // A failed save retains the selection and permits an explicit retry.
    expect(page.querySelector('.resolution-file-body .ui.dropdown .text')?.textContent).toBe('draft.pdf');
    attach = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Use this file');
    expect(attach?.disabled).toBe(false);
    await act(async () => {attach?.click(); for (let index = 0; index < 8; index += 1) await Promise.resolve();});
    expect(createDocumentVersion).toHaveBeenCalledTimes(2);

  });

  it.each(['PENDING_REVIEW', 'DELETED'] as const)('keeps %s references without publishing in the document page', async status => {
    const file = {id: 'file', committeeId: 'committee', logicalName: 'draft.pdf', mediaType: 'application/pdf',
      status: 'PENDING_REVIEW' as const, syncState: 'SYNCED' as const, createdByUserId: 'user',
      currentVersion: {id: 'file-version', versionNumber: 1, originalName: 'draft.pdf', mediaType: 'application/pdf',
        sizeBytes: 4, sha256: 'a'.repeat(64), blobId: 'blob', createdAt: '2026-08-14T00:00:00.000Z'},
      revision: 2, submittedAt: '2026-08-14T00:01:00.000Z', publishedAt: null,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:01:00.000Z'};
    const document: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'New draft resolution 1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 2, content: '', contentFile: {
        id: 'file', logicalName: 'draft.pdf', originalName: 'draft.pdf', mediaType: 'application/pdf',
        status, fileType: null}, createdAt: '2026-08-14T00:01:00.000Z'}, votingVersionId: null, public: false,
      proposers: [], seconders: [], delegatesCanAmend: false, directVote: null, resultDecisions: [],
      revision: 2, discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:01:00.000Z'};
    const publishFile = vi.fn(async () => ({...file, status: 'PUBLISHED' as const, revision: 3,
      publishedAt: '2026-08-14T00:02:00.000Z'}));
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/text', user,
      value => ({...value, documents: [document]}), {listFiles: vi.fn(async () => [file]), publishFile});
    await act(async () => {await Promise.resolve(); await Promise.resolve();});
    const publish = [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Publish file');
    expect(publish).toBeUndefined();
    expect(page.textContent).toContain('The referenced file is unavailable.');
    expect(Boolean(page.querySelector('a[href="/committees/committee/posts/review"]'))).toBe(status === 'PENDING_REVIEW');
    expect(page.querySelector('input[type="file"]')).toBeNull();
    expect(publishFile).not.toHaveBeenCalled();
  });

  it('does not save untouched automatic titles or text when focus moves away', async () => {
    const createDocumentVersion = vi.fn();
    const document: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'Draft resolution 1.1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: false,
      proposers: [], seconders: [], delegatesCanAmend: false, directVote: null, resultDecisions: [],
      revision: 1, discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/text', user,
      value => ({...value, documents: [document]}), {createDocumentVersion});
    await act(async () => {
      page.querySelector('input[aria-label="Set resolution name"]')?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
      page.querySelector('textarea')?.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
    });
    expect(createDocumentVersion).not.toHaveBeenCalled();
  });

  it('renders country rows with flags and serializes additions and removals for both draft lists', async () => {
    const china = {seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD' as const, value: 'cn'}};
    const france = {seatId: 'france', seatDisplayName: 'France', flag: {type: 'STANDARD' as const, value: 'fr'}};
    let document: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'Draft resolution 1.1', status: 'DRAFT',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: false, proposers: [china, france],
      seconders: [], delegatesCanAmend: false, directVote: null, resultDecisions: [], revision: 1,
      discussion: [], createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    let finish: (() => void) | undefined;
    const updateDocumentSettings = vi.fn(async (_id, input) => {
      await new Promise<void>(resolve => {finish = resolve;});
      document = {...document, revision: document.revision + 1,
        proposers: input.proposerSeatIds ? [china, france].filter(item => input.proposerSeatIds.includes(item.seatId)) : document.proposers,
        seconders: input.seconderSeatIds ? [china, france].filter(item => input.seconderSeatIds.includes(item.seatId)) : document.seconders};
      return document;
    });
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/text', user,
      value => ({...value, seats: [...value.seats, {...value.seats[0], id: 'france', displayName: 'France', flag: france.flag}],
        attendance: ['seat', 'france'].map(seatId => ({seatId, state: 'PRESENT', canVote: true, revision: 1, lastEventId: 'present', updatedAt: '2026-08-14T00:00:00.000Z'})),
        documents: [document]}), {updateDocumentSettings});
    const lists = () => [...page.querySelectorAll('.resolution-country-list')];
    expect([...lists()[0].querySelectorAll('li')].map(row => row.textContent)).toEqual(['China', 'France']);
    expect(lists()[0].querySelectorAll('li .country-flag-display')).toHaveLength(2);
    await act(async () => {page.querySelector<HTMLButtonElement>('[aria-label="Remove France"]')?.click();
      page.querySelector<HTMLButtonElement>('[aria-label="Remove China"]')?.click();});
    expect(updateDocumentSettings).toHaveBeenCalledTimes(1);
    expect(updateDocumentSettings).toHaveBeenLastCalledWith('resolution', {baseRevision: 1, proposerSeatIds: ['seat']});
    await act(async () => {finish?.();});
    expect(lists()[0].querySelectorAll('li')).toHaveLength(1);
    await act(async () => {lists()[1].querySelector<HTMLElement>('.dropdown')?.click();});
    await act(async () => {([...lists()[1].querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent === 'France'))?.click();});
    await act(async () => {([...lists()[1].querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'Add country'))?.click();});
    expect(updateDocumentSettings).toHaveBeenLastCalledWith('resolution', {baseRevision: 2, seconderSeatIds: ['france']});
    await act(async () => {finish?.();});
    expect(lists()[1].querySelector('li')?.textContent).toBe('France');
    expect(lists()[1].querySelectorAll('li .country-flag-display')).toHaveLength(1);
  });

  it('serializes rapid resolution votes and changes the cursor and undo history only after success', async () => {
    let document: ProceedingDocument = {id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting',
      kind: 'RESOLUTION', resolutionId: null, ordinal: 1, customTitle: null, title: 'A/RES/1', status: 'PUBLISHED',
      rulePackageVersionId: 'rules', currentVersion: {id: 'version', versionNumber: 1, content: 'Text', contentFile: null,
        createdAt: '2026-08-14T00:00:00.000Z'}, votingVersionId: null, public: true, proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}],
      seconders: [], delegatesCanAmend: false, directVote: {majority: 'SIMPLE_MAJORITY', startedAt: null,
        settingsRevision: 1, eligibility: [{seatId: 'seat', seatDisplayName: 'China', mustVote: false, hasVeto: false},
          {seatId: 'second', seatDisplayName: 'France', mustVote: false, hasVeto: false}], threshold: 2,
        automaticResult: null, votes: []}, resultDecisions: [], revision: 2, discussion: [],
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};
    let finish: () => void = () => undefined;
    let fail: () => void = () => undefined;
    const setResolutionDirectVote = vi.fn((_id: string, seatId: string, choice: 'FOR' | 'AGAINST' | 'ABSTAIN' | null) =>
      new Promise<ProceedingDocument>((resolve, reject) => {
        finish = () => {
          const votes = document.directVote!.votes.filter(vote => vote.seatId !== seatId);
          if (choice !== null) votes.push({id: 'vote', castAt: '2026-09-22T00:00:00Z', seatId, choice, seatDisplayName: seatId === 'seat' ? 'China' : 'France', revision: 1});
          document = {...document, directVote: {...document.directVote!, votes}};
          resolve(document);
        };
        fail = () => reject(new Error('connection lost'));
      }));
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/voting', user,
      value => ({...value, documents: [document]}), {setResolutionDirectVote});
    const button = (label: string) => [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent?.trim() === label)!;
    const currentSeat = () => page.querySelector('.resolution-voting-current .header')?.textContent;
    await act(async () => {button('Yes').click(); button('Yes').click(); button('No').click();});
    expect(setResolutionDirectVote).toHaveBeenCalledTimes(1);
    expect(currentSeat()).toBe('China');
    expect(button('Yes').disabled).toBe(true);
    expect(button('Undo').disabled).toBe(true);
    await act(async () => finish());
    expect(currentSeat()).toBe('France');
    expect(button('Undo').disabled).toBe(false);
    await act(async () => {button('No').click();});
    await act(async () => fail());
    expect(currentSeat()).toBe('France');
    expect(button('Undo').disabled).toBe(false);
    await act(async () => {button('Undo').click(); button('Undo').click();});
    expect(setResolutionDirectVote).toHaveBeenCalledTimes(3);
    expect(setResolutionDirectVote).toHaveBeenLastCalledWith('resolution', 'seat', null);
    await act(async () => fail());
    expect(currentSeat()).toBe('France');
    expect(button('Undo').disabled).toBe(false);
    await act(async () => {button('Undo').click();});
    expect(setResolutionDirectVote).toHaveBeenLastCalledWith('resolution', 'seat', null);
    await act(async () => finish());
    expect(currentSeat()).toBe('China');
    expect(document.directVote?.votes).toHaveLength(0);
    expect(button('Undo').disabled).toBe(true);
  });

  it.each([null, 'PASSED', 'FAILED', 'VETOED'] as const)(
    'keeps resolution voting controls and shows undo only while the result is pending (%s)', async automaticResult => {
    const setResolutionDirectVote = vi.fn(async (): Promise<ProceedingDocument> => ({} as ProceedingDocument));
    const page = await render('CHAIR', '/committees/committee/resolutions/resolution/voting', user, value => ({...value,
      attendance: [{seatId: 'seat', state: 'PRESENT', lastEventId: 'attendance',
        updatedAt: '2026-08-14T00:00:00.000Z'}],
      documents: [{id: 'resolution', committeeId: 'committee', meetingSessionId: 'meeting', kind: 'RESOLUTION',
        resolutionId: null, ordinal: 1, customTitle: null, title: 'A/RES/1', status: 'PUBLISHED', rulePackageVersionId: 'rules',
        currentVersion: {id: 'version', versionNumber: 1, content: '', contentFile: null,
          createdAt: '2026-08-14T00:00:00.000Z'},
        votingVersionId: null, public: true, proposers: [{seatId: 'seat', seatDisplayName: 'China', flag: {type: 'STANDARD', value: 'cn'}}], seconders: [], delegatesCanAmend: false,
        directVote: {majority: 'SIMPLE_MAJORITY', startedAt: null, settingsRevision: 1,
          eligibility: [{seatId: 'seat', seatDisplayName: 'China', mustVote: false, hasVeto: true}], threshold: 1,
          automaticResult, votes: []}, resultDecisions: [], revision: 2, discussion: [],
        createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'}]}),
    {setResolutionDirectVote});
    expect(page.querySelector('.resolution-voting-board')).not.toBeNull();
    expect(page.querySelectorAll('.resolution-voting-member')).toHaveLength(1);
    expect(page.textContent).toContain('Now voting');
    expect(page.textContent).toContain('Formal Ballot');
    const undo = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Undo');
    expect(Boolean(undo)).toBe(automaticResult === null);
    if (automaticResult === null) expect(undo?.disabled).toBe(true);
    const yes = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Yes');
    await act(async () => {yes?.click(); await Promise.resolve();});
    expect(setResolutionDirectVote).toHaveBeenCalledWith('resolution', 'seat', 'FOR');
    if (automaticResult === null) expect(undo?.disabled).toBe(false);
  });

  it('keeps storage inside the account-authorized resource tabs', async () => {
    const apiOverrides = {listFiles: vi.fn(async () => []), listPendingHostCommits: vi.fn(async () => []),
      listStorageBindings: vi.fn(async () => []), listS3ProviderConfigs: vi.fn(async () => []),
      listStorageMigrations: vi.fn(async () => []), listStorageHosts: vi.fn(async () => []),
      listStorageAgentConflicts: vi.fn(async () => [])};
    const memberPage = await render('MEMBER', '/committees/committee/posts', user, value => value, apiOverrides);
    expect(memberPage.textContent).not.toContain('Text resources');
    expect(memberPage.textContent).not.toContain('Link resources');
    expect(memberPage.textContent).toContain('File overview');
    expect(memberPage.querySelector('a[href="/committees/committee/posts/storage"]')).toBeNull();
    expect(memberPage.querySelector('.ui.negative.message')).toBeNull();
    act(() => root?.unmount()); root = undefined; container?.remove(); container = undefined;
    const chairPage = await render('CHAIR', '/committees/committee/posts', user, value => value, apiOverrides);
    expect(chairPage.querySelector('a[href="/committees/committee/posts/storage"]')?.textContent).toBe('Storage settings');
    expect(chairPage.querySelector('.ui.negative.message')).toBeNull();
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
    expect(stats).toContain('Motions proposed');
    expect(stats).toContain('Amendments proposed');
    expect(stats).toContain('Document discussion entries');
    expect(stats).toContain('China');
  });
  it('redirects hidden resource routes to attachments', async () => { const page = await render('CHAIR', '/committees/committee/posts/links', user, value => ({...value, textPosts: [{id: 'link', title: 'Research', content: 'link:https://example.test/research', sortOrder: 0, revision: 1, authorSeatId: 'seat', authorDisplayName: 'China', actorUserId: 'chair', createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', deletedAt: null}]})); expect(page.textContent).toContain('File overview'); expect(page.textContent).not.toContain('Link resources'); expect(page.textContent).not.toContain('Publisher: China'); expect(page.querySelector('a[href="https://example.test/research"]')).toBeNull(); });
  it('retains prefetched file data across routes and clears it when access becomes read-only', async () => {
    const share = {id: 'share', url: 'https://example.test/delegate-files#test', revision: 1};
    const getDelegateFileShare = vi.fn().mockResolvedValueOnce(share).mockImplementation(() => new Promise(() => {}));
    const listDelegateReviewFiles = vi.fn().mockResolvedValueOnce([{
      id: 'reviewed', logicalName: 'cached.pdf', originalName: 'cached.pdf', status: 'PENDING_REVIEW',
      submittedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z'
    }]).mockImplementation(() => new Promise(() => {}));
    let disconnect: (() => void) | undefined;
    let sequence = 1;
    const page = await render('CHAIR', '/committees/committee/posts/review', user, value => ({...value,
      committee: {...value.committee, operationMode: 'CHAIR_OPERATED'},
      sync: {...value.sync, committeeEventSequence: sequence}}), {
      listStorageBindings: vi.fn().mockResolvedValueOnce([{status: 'ACTIVE', providerType: 'CHAIR_AGENT'}])
        .mockRejectedValue(new Error('binding refresh failed')),
      getDelegateFileShare, listDelegateReviewFiles,
      openCommitteeEvents: (_id, _after, handlers) => {disconnect = () => handlers.onState('OFFLINE_READONLY'); return () => undefined;}
    });
    expect(getDelegateFileShare).toHaveBeenCalledTimes(1);
    expect(page.textContent).toContain('cached.pdf');
    await act(async () => page.querySelector<HTMLAnchorElement>('a[href="/committees/committee/posts/share"]')!.click());
    expect(page.querySelector<HTMLInputElement>('.delegate-file-share-panel input')?.value).toBe(share.url);
    expect(page.textContent).not.toContain('开始分享');
    await act(async () => page.querySelector<HTMLAnchorElement>('a[href="/committees/committee/posts/attachments"]')!.click());
    expect(page.textContent).toContain('cached.pdf');
    expect(page.textContent).not.toContain('暂无已审核文件');
    sequence = 2;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(page.textContent).toContain('Request failed. Try again later.');
    expect(page.textContent).toContain('cached.pdf');
    await act(async () => disconnect!());
    expect(page.querySelector('.delegate-file-review-panel')).toBeNull();
    expect(page.textContent).not.toContain('cached.pdf');
    expect(page.querySelector('a[href="/committees/committee/posts/share"]')).toBeNull();
  });
  it.each(['SERVER_VOLUME', 'CHAIR_AGENT', 'S3_COMPATIBLE', 'UNCONFIGURED'])('keeps the same file menu for %s', async providerType => {
    const page = await render('CHAIR', '/committees/committee/posts/attachments', user, value => ({...value,
      committee: {...value.committee, operationMode: 'CHAIR_OPERATED'}}), {
      listStorageBindings: vi.fn(async () => providerType === 'UNCONFIGURED' ? [] : [{id: 'binding', committeeId: 'committee', providerType: providerType as 'CHAIR_AGENT',
        providerConfigId: null, storageHostId: 'host', status: 'ACTIVE', revision: 1,
        createdAt: '2026-09-01T00:00:00.000Z'}] as Awaited<ReturnType<SelfHostedApi['listStorageBindings']>>),
      getDelegateFileShare: vi.fn(async () => null),
      listDelegateReviewFiles: vi.fn(async () => [])
    });
    await act(async () => {await Promise.resolve(); await Promise.resolve();});
    expect(page.querySelector('a[href="/committees/committee/posts/attachments"]')).not.toBeNull();
    const resourceLinks = Array.from(page.querySelectorAll<HTMLAnchorElement>('[aria-label="Resource sections"] a'))
      .map(link => link.textContent?.trim());
    expect(resourceLinks).toEqual(['File overview', 'Share', 'Upload files', 'Storage settings', 'File settings']);
    expect(page.querySelector('.delegate-file-chair-upload')).toBeNull();
    await act(async () => {page.querySelector<HTMLAnchorElement>('a[href="/committees/committee/posts/upload"]')?.click(); await Promise.resolve();});
    if (providerType === 'UNCONFIGURED') expect(page.textContent).toContain('Configure storage before uploading or sharing files.');
    else expect(page.querySelector('.delegate-file-chair-upload')).not.toBeNull();
    expect(page.querySelector('.delegate-file-card-list')).toBeNull();
  });
  it.each(['MANUAL', 'LINK'] as const)('keeps draft options through blur and starts %s once', async medium => {
    let poll: Strawpoll = {id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1,
      question: '', votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN', stage: 'PREPARING',
      medium: 'LINK', optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null,
      options: [], seatVotes: [], revision: 1, createdAt: '2026-08-16T00:00:00.000Z', closedAt: null};
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const reviseStrawpoll = vi.fn<SelfHostedApi['reviseStrawpoll']>(async (_id, input) => {
      await pending;
      poll = {...poll, id: 'next-poll', revision: 1, question: input.question, medium: input.medium,
        options: input.options.map((label, index) => ({id: `option-${index}`, label, voteCount: 0, sortOrder: index}))};
      return poll;
    });
    const commandStrawpollStage = vi.fn<SelfHostedApi['commandStrawpollStage']>(async () => {
      poll = {...poll, stage: 'VOTING', revision: 2}; return poll;
    });
    const page = await render('CHAIR', '/committees/committee/strawpolls/poll', user,
      value => ({...value, strawpolls: [poll]}), {reviseStrawpoll, commandStrawpollStage});
    const input = async (name: string, value: string) => {
      const element = page.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
      expect(element).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', {bubbles: true}));
      });
      await act(async () => {element.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));});
    };
    const button = (text: string) => [...page.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.includes(text))!;
    await input('Poll question', 'Which option?');
    await act(async () => {button('Add option').click();});
    await input('Poll option 1', 'Option A');
    await act(async () => {button('Add option').click();});
    expect(page.querySelector('input[aria-label="Poll option 2"]')).not.toBeNull();
    await input('Poll option 2', 'Option B');
    expect(reviseStrawpoll).not.toHaveBeenCalled();
    const create = button(medium === 'MANUAL' ? 'Create manual poll' : 'Create shareable poll');
    await act(async () => {create.click(); create.click();});
    expect(reviseStrawpoll).toHaveBeenCalledTimes(1);
    expect(create.disabled).toBe(true);
    expect(reviseStrawpoll).toHaveBeenCalledWith('poll', expect.objectContaining({
      baseRevision: 1, question: 'Which option?', options: ['Option A', 'Option B'], medium}));
    await act(async () => {release(); await pending;});
    expect(commandStrawpollStage).toHaveBeenCalledTimes(1);
    expect(commandStrawpollStage).toHaveBeenCalledWith('next-poll', 1, 'START');
    expect(page.textContent).toContain('View results');
    expect(page.querySelector('input[aria-label="Poll question"]')).toBeNull();
  });
  it('keeps the strawpoll page mounted while typing a newly added option', async () => { const page = await render('CHAIR', '/committees/committee/strawpolls/poll', user, value => ({...value, strawpolls: [{id: 'poll', committeeId: 'committee', meetingSessionId: 'meeting', ordinal: 1, question: 'Choice?', votingMode: 'SEAT_AUTHENTICATED', multipleChoice: true, status: 'OPEN', stage: 'PREPARING', medium: 'LINK', optionsArePublic: false, seriesId: 'poll', roundNumber: 1, supersededById: null, options: [], seatVotes: [], revision: 1, createdAt: '2026-08-16T00:00:00.000Z', closedAt: null}]})); const add = [...page.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Add option')); await act(async () => {add?.click(); await Promise.resolve();}); const option = page.querySelectorAll<HTMLInputElement>('.strawpoll-page input')[1]; await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(option, 'Option A'); option?.dispatchEvent(new Event('input', {bubbles: true})); await Promise.resolve();}); expect(page.querySelector('.strawpoll-page')).not.toBeNull(); expect(page.textContent).toContain('Create manual poll'); });
});
