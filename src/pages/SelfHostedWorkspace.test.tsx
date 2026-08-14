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
  notes: [{id: 'note', title: 'Agenda', content: 'Opening debate', sortOrder: 0, revision: 1, createdByUserId: 'user',
    createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', deletedAt: null}],
  textPosts: [], sync: {committeeEventSequence: 7}};
let root: Root | undefined; let container: HTMLDivElement | undefined;

afterEach(() => { if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });

describe('self-hosted stage 4 workspace', () => {
  it('loads the API snapshot and revalidates when the window regains focus', async () => {
    const api = {snapshot: vi.fn(async () => snapshot), openCommitteeEvents: vi.fn(() => () => undefined)} as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={api} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('Security Council');
    expect(container.textContent).toContain('China');
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.openCommitteeEvents).toHaveBeenCalledWith('committee', 7, expect.any(Object));
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
    const item = Array.from(container.querySelectorAll('.item')).find(node => node.textContent === '议事');
    expect(item).toBeTruthy();
    await act(async () => { item?.dispatchEvent(new MouseEvent('click', {bubbles: true})); });
    expect(container.textContent).toContain('发言名单');
    expect(container.textContent).toContain('正式表决');
    expect(container.textContent).toContain('决议草案与修正案');
  });

  it('lets only the owner archive an active committee and export an archived committee', async () => {
    const ownerSnapshot: CommitteeWorkspaceSnapshot = {...snapshot,
      viewer: {audience: 'OWNER', seatId: null}, committee: {...snapshot.committee, ownerUserId: user.id}};
    const archiveCommittee = vi.fn(async () => ({...ownerSnapshot.committee, status: 'ARCHIVED' as const, revision: 2}));
    const activeApi = {snapshot: vi.fn(async () => ownerSnapshot), openCommitteeEvents: vi.fn(() => () => undefined),
      archiveCommittee, committeeExportUrl: vi.fn(() => '/api/v1/committees/committee/export')} as unknown as SelfHostedApi;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={activeApi} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    const archive = Array.from(container.querySelectorAll('button')).find(item => item.textContent === '归档委员会');
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
    await act(async () => { root?.render(<MemoryRouter initialEntries={['/committees/committee']}>
      <SelfHostedWorkspace user={user} logout={() => undefined} api={archivedApi} />
    </MemoryRouter>); await Promise.resolve(); await Promise.resolve(); });
    const link = Array.from(container.querySelectorAll('a')).find(item => item.textContent === '导出记录');
    expect(link?.getAttribute('href')).toBe('/api/v1/committees/committee/export');
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Security Council');
    const remove = Array.from(container.querySelectorAll('button')).find(item => item.textContent === '永久删除委员会');
    await act(async () => {remove?.click(); await Promise.resolve(); await Promise.resolve();});
    expect(prompt).toHaveBeenCalledWith('此操作不可恢复。请输入委员会名称“Security Council”确认永久删除：');
    expect(requestCommitteeDeletion).toHaveBeenCalledWith('committee', 2, 'Security Council');
    expect(container.textContent).not.toContain('保存更改');
    expect(container.textContent).not.toContain('归档委员会');
    const notes = Array.from(container.querySelectorAll('.item')).find(item => item.textContent === 'notes');
    await act(async () => {notes?.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    expect(container.textContent).toContain('Opening debate');
    const noteButtons = Array.from(container.querySelectorAll('button')).map(item => item.textContent);
    expect(noteButtons).not.toContain('Edit'); expect(noteButtons).not.toContain('Delete');
    const proceedings = Array.from(container.querySelectorAll('.item')).find(item => item.textContent === '议事');
    await act(async () => {proceedings?.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    expect(container.textContent).toContain('正式表决');
    expect(container.textContent).not.toContain('提出动议');
    expect(container.textContent).not.toContain('新建决议草案');
  });
});
