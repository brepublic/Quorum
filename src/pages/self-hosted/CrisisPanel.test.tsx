import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, CrisisGroup} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {setLanguage} from '../../i18n';
import {CommitteeWorkspaceProvider, useCommitteeWorkspace} from './CommitteeWorkspaceContext';
import CrisisPanel from './CrisisPanel';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  setLanguage('zh-CN');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {act(() => root.unmount()); host.remove(); setLanguage('en');});

function Panel({api}: {api: SelfHostedApi}) {
  const {snapshot, run} = useCommitteeWorkspace();
  return snapshot ? <CrisisPanel snapshot={snapshot} run={run} api={api} canChair resourceId="crisis" /> : null;
}

async function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, ''); input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  for (let length = 1; length <= value.length; length++) {
    await act(async () => {
      setter.call(input, value.slice(0, length));
      input.dispatchEvent(new Event('input', {bubbles: true}));
    });
  }
}

describe('crisis card input', () => {
  it.each([
    {label: '危机标题', value: '港口封锁 Crisis 123', expected: {title: '港口封锁 Crisis 123', handlingDurationMs: 60_000}},
    {label: '处理时间（分钟）', value: '12.5', expected: {title: '原标题', handlingDurationMs: 750_000}}
  ])('keeps rendering during sequential $label edits and saves on blur', async ({label, value, expected}) => {
    let group = {id: 'crisis', committeeId: 'committee', meetingSessionId: 'meeting', sessionOrdinal: 1,
      ordinal: 2, nextUpdateOrdinal: 2, revision: 1, endedAt: null, autoStartAt: null,
      timer: {id: 'timer', committeeId: 'committee', ownerType: 'CRISIS', ownerId: 'crisis', running: false,
        startedAt: null, remainingAtStartMs: 0, remainingMs: 0, revision: 1, expiredAt: null, serverTime: ''},
      updates: [{id: 'card', groupId: 'crisis', ordinal: 1, title: '原标题', status: 'UNPUBLISHED',
        handlingDurationMs: 60_000, notice: null, revision: 1, publishedAt: null}]} as CrisisGroup;
    const read = () => ({committee: {id: 'committee', status: 'ACTIVE'}, crises: [group],
      sync: {committeeEventSequence: 1}} as unknown as CommitteeWorkspaceSnapshot);
    const updateCrisisCard = vi.fn(async (_id: string, payload: Parameters<SelfHostedApi['updateCrisisCard']>[1]) => {
      group = {...group, updates: [{...group.updates[0], title: payload.title ?? group.updates[0].title,
        handlingDurationMs: payload.handlingDurationMs === undefined ? group.updates[0].handlingDurationMs : payload.handlingDurationMs, revision: 2}]};
      return group;
    });
    let finishRefresh!: (snapshot: CommitteeWorkspaceSnapshot) => void;
    const refreshed = new Promise<CommitteeWorkspaceSnapshot>(resolve => {finishRefresh = resolve;});
    const api = {snapshot: vi.fn().mockImplementationOnce(async () => read()).mockImplementation(() => refreshed),
      openCommitteeEvents: vi.fn(() => () => undefined),
      listDelegateReviewFiles: vi.fn(async () => []), updateCrisisCard} as unknown as SelfHostedApi;
    await act(async () => root.render(<MemoryRouter><CommitteeWorkspaceProvider committeeId="committee" api={api}>
      <Panel api={api} />
    </CommitteeWorkspaceProvider></MemoryRouter>));
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await enter(input, value);
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(value);
    expect(host.textContent).toContain('危机 1.2.1');
    expect(host.textContent).toContain('发布危机');
    expect(updateCrisisCard).not.toHaveBeenCalled();
    await act(async () => {input.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));});
    expect(updateCrisisCard).toHaveBeenCalledTimes(1);
    expect(updateCrisisCard).toHaveBeenCalledWith('card', {
      baseRevision: 1, ...expected, fileId: null, replaceNoticeId: undefined
    });
    // The save response can arrive before the workspace snapshot catches up.
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.disabled).toBe(true);
    expect([...host.querySelectorAll('.crisis-card form button')].map(button => button.textContent)).toEqual(['发布危机']);
    await act(async () => {finishRefresh(read());});
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(value);
    expect(group.updates[0].status).toBe('UNPUBLISHED');
  });
});
