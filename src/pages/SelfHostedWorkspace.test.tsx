import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import SelfHostedWorkspace from './SelfHostedWorkspace';
import type {SelfHostedApi} from '../services/self-hosted-api';
import type {SelfHostedUser} from '../services/self-hosted-identity';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const user: SelfHostedUser = {id: 'user', email: 'user@example.com', displayName: 'User', status: 'ACTIVE',
  isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null};
const snapshot: CommitteeWorkspaceSnapshot = {schemaVersion: 2,
  committee: {id: 'committee', name: 'Security Council', chairLabel: 'Chair', topic: '', conference: '', visibility: 'PRIVATE',
    operationMode: 'DELEGATE_OPERATED', status: 'ACTIVE', activeRulePackageVersionId: 'rules', revision: 1},
  seats: [{id: 'seat', stableKey: 'china', displayName: 'China', rank: 'VETO', canVote: true, hasVeto: true,
    mustVote: false, sortOrder: 0, active: true, revision: 1, flag: {type: 'STANDARD', value: 'cn'}}],
  viewer: {audience: 'MEMBER', seatId: 'seat'}, attendance: [], points: [],
  motionSettings: {delegateMotionProposalsEnabled: false, delegateMotionVotingEnabled: false},
  layoutSettings: {moveQueueUp: false, timersInSeparateColumns: false},
  activeRules: {versionId: 'rules', activePhaseId: null, phases: [], attendanceResponses: ['PRESENT', 'ABSENT'],
    pointTypes: [], motionTypes: [], speakerLists: [], ballots: {delegateMayChangeVote: false,
      chairMayCorrectVote: true, anonymousStrawpoll: false, mustCollectAllVotesWhenVetoSeatEligible: true},
    documents: {amendmentsPublicByDefault: false}},
  notes: [{id: 'note', title: 'Agenda', content: 'Opening debate', sortOrder: 0, revision: 1, createdByUserId: 'user',
    createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', deletedAt: null}],
  textPosts: [], sync: {committeeEventSequence: 7}};
let root: Root | undefined; let container: HTMLDivElement | undefined;

afterEach(() => { if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });

describe('self-hosted stage 4 workspace', () => {
  it('restores the legacy two-column committee creation workspace without dropping self-hosted templates', async () => {
    const logout = vi.fn();
    const archiveCommittee = vi.fn(async () => ({id: 'committee', name: 'Security Council', status: 'ARCHIVED' as const, revision: 2}));
    const requestCommitteeDeletion = vi.fn(async () => ({id: 'job'}));
    const api = {
      listCommittees: vi.fn(async () => [{id: 'committee', ownerUserId: user.id, ownerDisplayName: 'User',
        viewerRole: 'OWNER', name: 'Security Council', status: 'ACTIVE', revision: 1},
      {id: 'managed', ownerUserId: 'owner', ownerDisplayName: 'Committee Owner', viewerRole: 'CHAIR',
        name: 'Managed Committee', status: 'ACTIVE'}]),
      listCountryTemplates: vi.fn(async () => [{key: 'builtin:default', names: {en: 'Default countries'},
        defaultLanguage: 'en', builtin: true}]),
      listCommitteeTemplates: vi.fn(async () => []),
      archiveCommittee, requestCommitteeDeletion,
    } as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees']}>
      <SelfHostedWorkspace user={user} logout={logout} api={api} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    const page = container.querySelector('.committee-create-page');
    expect(page?.querySelectorAll(':scope > .ui.grid > .column')).toHaveLength(2);
    expect(page?.textContent).toContain('User');
    expect(page?.textContent).toContain('Security Council');
    expect(page?.textContent).toContain('My created committees');
    expect(page?.textContent).toContain('My managed committees');
    expect(page?.textContent).toContain('Owner: Committee Owner');
    expect(page?.textContent).not.toContain('My participating committees');
    const deleteButtons = page?.querySelectorAll('button[aria-label^="Delete committee"]');
    expect(deleteButtons).toHaveLength(1);
    expect(deleteButtons?.[0]?.getAttribute('aria-label')).not.toContain('Managed Committee');
    await act(async () => { (deleteButtons?.[0] as HTMLButtonElement | undefined)?.click(); });
    expect(document.body.textContent).toContain('This permanently deletes the committee and all of its records and uploaded files.');
    const confirm = Array.from(document.body.querySelectorAll('button')).find(button => button.textContent === 'Delete committee');
    await act(async () => { confirm?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(archiveCommittee).toHaveBeenCalledWith('committee', 1);
    expect(requestCommitteeDeletion).toHaveBeenCalledWith('committee', 2, 'Security Council');
    expect(page?.textContent).not.toContain('Security Council');
    expect(page?.textContent).toContain('Create committee');
    expect(page?.textContent).toContain('Country template');
  });

  it('loads the API snapshot and revalidates when the window regains focus', async () => {
    let callbacks: Parameters<SelfHostedApi['openCommitteeEvents']>[2] | undefined;
    const api = {snapshot: vi.fn(async () => snapshot), openCommitteeEvents: vi.fn((_id, _after, next) => {
      callbacks = next; return () => undefined;
    })} as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={api} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('Security Council');
    expect(container.textContent).toContain('Share committee');
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.openCommitteeEvents).toHaveBeenCalledWith('committee', 7, expect.any(Object));
    act(() => callbacks?.onState('OFFLINE_READONLY'));
    expect(container.textContent).toContain('Offline read-only');
    const notes = container.querySelector<HTMLAnchorElement>('a[href="/committees/committee/notes"]');
    await act(async () => {notes?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));});
    expect(container.textContent).toContain('Opening debate');
    expect(container.textContent).not.toContain('New note');
    expect(container.textContent).not.toContain('Save note');
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve(); });
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it('exposes stage 5 proceedings from the same-origin workspace', async () => {
    const proceedings: CommitteeWorkspaceSnapshot = {...snapshot,
      meetingSession: {id: 'session', committeeId: 'committee', phaseId: 'formal-debate', activeRulePackageVersionId: 'rules',
        status: 'OPEN', revision: 1, createdAt: '2026-08-13T00:00:00.000Z', closedAt: null},
      timers: [], speakerLists: [], motions: [], ballots: [], strawpolls: [], documents: []};
    const api = {snapshot: vi.fn(async () => proceedings), openCommitteeEvents: vi.fn(() => () => undefined)} as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={api} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    const item = container.querySelector<HTMLAnchorElement>('a[href="/committees/committee/motions"]');
    expect(item).toBeTruthy();
    await act(async () => { item?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})); });
    expect(container.textContent).toContain('Motions');
    expect(container.textContent).not.toContain('Formal ballot');
    expect(container.querySelector('.committee-workspace-page')?.textContent).not.toContain('Create strawpoll');
  });

  it('offers point types from the active rule read model', async () => {
    const ruleDriven: CommitteeWorkspaceSnapshot = {...snapshot,
      meetingSession: {id: 'session', committeeId: 'committee', phaseId: 'formal-debate', activeRulePackageVersionId: 'rules',
        status: 'OPEN', revision: 1, createdAt: '2026-08-13T00:00:00.000Z', closedAt: null},
      activeRules: {...snapshot.activeRules, activePhaseId: 'formal-debate', pointTypes: [
        {id: 'point-of-order', names: {en: 'Point of order', 'zh-CN': '程序性问题'}, interruptRequested: true}
      ]}};
    const api = {snapshot: vi.fn(async () => ruleDriven), openCommitteeEvents: vi.fn(() => () => undefined)} as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee/points']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={api} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('Point of order');
    expect(container.querySelector('input[value="point-of-order"]')).toBeNull();
  });

  it('lets only the owner archive an active committee and export an archived committee', async () => {
    const ownerSnapshot: CommitteeWorkspaceSnapshot = {...snapshot,
      viewer: {audience: 'OWNER', seatId: null}, committee: {...snapshot.committee, ownerUserId: user.id}};
    const archiveCommittee = vi.fn(async () => ({...ownerSnapshot.committee, status: 'ARCHIVED' as const, revision: 2}));
    const activeApi = {snapshot: vi.fn(async () => ownerSnapshot), openCommitteeEvents: vi.fn(() => () => undefined),
      archiveCommittee, committeeExportUrl: vi.fn(() => '/api/v1/committees/committee/export'),
      listRulePackages: vi.fn(async () => [])} as unknown as SelfHostedApi;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee/settings']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={activeApi} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    const archive = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Archive committee');
    await act(async () => { archive?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(archiveCommittee).toHaveBeenCalledWith('committee', 1);
    act(() => root?.unmount()); root = undefined; container.remove();

    const archived: CommitteeWorkspaceSnapshot = {...ownerSnapshot,
      committee: {...ownerSnapshot.committee, status: 'ARCHIVED' as const, revision: 2},
      meetingSession: {id: 'session', committeeId: 'committee', phaseId: 'formal-debate', activeRulePackageVersionId: 'rules',
        status: 'OPEN', revision: 1, createdAt: '2026-08-13T00:00:00.000Z', closedAt: null},
      timers: [], speakerLists: [], motions: [], ballots: [], strawpolls: [], documents: []};
    const requestCommitteeDeletion = vi.fn(async () => { throw new Error('cleanup queued'); });
    const archivedApi = {snapshot: vi.fn(async () => archived), openCommitteeEvents: vi.fn(() => () => undefined),
      committeeExportUrl: vi.fn(() => '/api/v1/committees/committee/export'), requestCommitteeDeletion} as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee/settings']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={archivedApi} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    const link = Array.from(container.querySelectorAll('a')).find(item => item.textContent === 'Export records');
    expect(link?.getAttribute('href')).toBe('/api/v1/committees/committee/export');
    const confirmation = container.querySelector('input');
    await act(async () => {if (confirmation) {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      ?.call(confirmation, 'Security Council'); confirmation.dispatchEvent(new Event('input', {bubbles: true}));}});
    const remove = Array.from(container.querySelectorAll('button')).find(item => item.textContent === 'Permanently delete committee');
    await act(async () => {remove?.click(); await Promise.resolve(); await Promise.resolve();});
    expect(requestCommitteeDeletion).toHaveBeenCalledWith('committee', 2, 'Security Council');
    expect(container.textContent).not.toContain('Save changes');
    expect(container.textContent).not.toContain('Archive committee');
    const notes = container.querySelector<HTMLAnchorElement>('a[href="/committees/committee/notes"]');
    await act(async () => {notes?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));});
    expect(container.textContent).toContain('Opening debate');
    const noteButtons = Array.from(container.querySelectorAll('button')).map(item => item.textContent);
    expect(noteButtons).not.toContain('Edit'); expect(noteButtons).not.toContain('Delete');
    const proceedings = container.querySelector<HTMLAnchorElement>('a[href="/committees/committee/motions"]');
    await act(async () => {proceedings?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));});
    expect(container.textContent).not.toContain('Formal ballot');
    expect(container.textContent).not.toContain('Propose motion');
    expect(container.textContent).not.toContain('新建决议草案');
  });
});
