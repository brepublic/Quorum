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
});
