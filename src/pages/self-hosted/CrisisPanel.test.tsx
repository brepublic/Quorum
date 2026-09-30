import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, CrisisGroup, DelegateReviewFile} from '@quorum/contracts';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';
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

async function mount({linked = true, delayedSave = false, failSave = false} = {}) {
  const files: DelegateReviewFile[] = ['notice', 'replacement'].map(id => ({id, logicalName: '危机通告 1.2.1',
    originalName: `${id}.pdf`, fileType: 'CRISIS_NOTICE', status: 'PENDING_REVIEW', submissionSource: 'CHAIR',
    submitterDisplayName: null, sizeBytes: 3, submittedAt: null, publishedAt: '', revision: 1}));
  let group = {id: 'crisis', committeeId: 'committee', meetingSessionId: 'meeting', sessionOrdinal: 1,
    ordinal: 2, nextUpdateOrdinal: 2, revision: 1, endedAt: null, autoStartAt: null,
    timer: {id: 'timer', committeeId: 'committee', ownerType: 'CRISIS', ownerId: 'crisis', running: false,
      startedAt: null, remainingAtStartMs: 0, remainingMs: 0, revision: 1, expiredAt: null, serverTime: ''},
    updates: [{id: 'card', groupId: 'crisis', ordinal: 1, title: '原标题', status: 'UNPUBLISHED',
      handlingDurationMs: 60_000, notice: linked ? files[0] : null, revision: 1, publishedAt: null}]} as CrisisGroup;
  const read = () => ({committee: {id: 'committee', status: 'ACTIVE'}, crises: [group],
    sync: {committeeEventSequence: 1}} as unknown as CommitteeWorkspaceSnapshot);
  let finishSave!: () => void;
  const saved = delayedSave ? new Promise<void>(resolve => {finishSave = resolve;}) : Promise.resolve();
  const updateCrisisCard = vi.fn(async (_id: string, payload: Parameters<SelfHostedApi['updateCrisisCard']>[1]) => {
    await saved;
    if (failSave) throw new SelfHostedApiError(409, 'REVISION_CONFLICT', 'Card changed.');
    group = {...group, updates: [{...group.updates[0], title: payload.title ?? group.updates[0].title,
      handlingDurationMs: payload.handlingDurationMs === undefined ? group.updates[0].handlingDurationMs : payload.handlingDurationMs,
      notice: files.find(file => file.id === payload.fileId) ?? null, revision: 2}]};
    return group;
  });
  const publishCrisis = vi.fn(async () => {
    group = {...group, updates: [{...group.updates[0], status: 'PENDING', publishedAt: '2026-09-30T00:00:00Z'}]};
    return group;
  });
  const api = {snapshot: vi.fn(async () => read()), openCommitteeEvents: vi.fn(() => () => undefined),
    listDelegateReviewFiles: vi.fn(async () => files), updateCrisisCard, publishCrisis} as unknown as SelfHostedApi;
  const render = async (key = 'page') => act(async () => root.render(<MemoryRouter key={key}>
    <CommitteeWorkspaceProvider committeeId="committee" api={api}><Panel api={api} /></CommitteeWorkspaceProvider>
  </MemoryRouter>));
  await render();
  return {api, updateCrisisCard, publishCrisis, finishSave, render};
}

const publishButton = () => host.querySelector<HTMLButtonElement>('.crisis-card form button')!;
async function selectReplacement() {
  const select = host.querySelector<HTMLElement>('[aria-label="危机通告"]')!;
  await act(async () => select.click());
  await act(async () => [...select.querySelectorAll<HTMLElement>('.item')]
    .find(item => item.textContent?.includes('replacement.pdf'))!.click());
}

describe('crisis card local drafts', () => {
  it.each([
    {label: '危机标题', value: '港口封锁 Crisis 123', expected: {title: '港口封锁 Crisis 123', handlingDurationMs: 60_000}},
    {label: '处理时间（分钟）', value: '12.5', expected: {title: '原标题', handlingDurationMs: 750_000}}
  ])('keeps sequential $label edits local and publishes on the first click', async ({label, value, expected}) => {
    const {updateCrisisCard, publishCrisis, finishSave} = await mount({delayedSave: true});
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => input.focus());
    await enter(input, value);
    await act(async () => {input.blur(); window.dispatchEvent(new Event('focus'));});
    expect(input.value).toBe(value);
    expect(input.disabled).toBe(false);
    expect(updateCrisisCard).not.toHaveBeenCalled();
    expect(publishCrisis).not.toHaveBeenCalled();
    await act(async () => input.focus());
    const button = publishButton();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
      input.blur(); button.click(); button.click();
    });
    expect(updateCrisisCard).toHaveBeenCalledTimes(1);
    expect(updateCrisisCard).toHaveBeenCalledWith('card', {
      baseRevision: 1, ...expected, fileId: 'notice', replaceNoticeId: undefined
    });
    expect(button.disabled).toBe(true);
    expect(publishCrisis).not.toHaveBeenCalled();
    await act(async () => finishSave());
    expect(publishCrisis).toHaveBeenCalledTimes(1);
    expect(publishCrisis).toHaveBeenCalledWith('card', 2, expect.any(String));
    expect(host.textContent).toContain('待处理');
    expect(host.querySelector(`input[aria-label="${label}"]`)).toBeNull();
  });

  it('keeps notice selection local and discards it on reopening the page', async () => {
    const {updateCrisisCard, publishCrisis, render} = await mount({linked: false});
    await selectReplacement();
    expect(updateCrisisCard).not.toHaveBeenCalled();
    expect(publishCrisis).not.toHaveBeenCalled();
    expect(publishButton().disabled).toBe(false);
    await render('reopened-page');
    expect(publishButton().disabled).toBe(true);
    await selectReplacement();
    await act(async () => publishButton().click());
    expect(updateCrisisCard).toHaveBeenCalledWith('card', {
      baseRevision: 1, title: '原标题', handlingDurationMs: 60_000, fileId: 'replacement', replaceNoticeId: undefined
    });
    expect(publishCrisis).toHaveBeenCalledWith('card', 2, expect.any(String));
  });

  it('confirms notice replacement locally and submits it only when publishing', async () => {
    const {updateCrisisCard, publishCrisis} = await mount();
    await selectReplacement();
    expect(document.querySelector('.modal')?.textContent).toContain('notice.pdf');
    await act(async () => document.querySelector<HTMLButtonElement>('.modal .actions button')!.click());
    expect(host.querySelector('[aria-label="危机通告"]')?.textContent).toContain('notice.pdf');
    await selectReplacement();
    await act(async () => document.querySelector<HTMLButtonElement>('.modal .actions button.primary')!.click());
    expect(document.querySelector('.modal')).toBeNull();
    expect(host.querySelector('[aria-label="危机通告"]')?.textContent).toContain('replacement.pdf');
    expect(updateCrisisCard).not.toHaveBeenCalled();
    expect(publishCrisis).not.toHaveBeenCalled();
    await act(async () => publishButton().click());
    expect(updateCrisisCard).toHaveBeenCalledWith('card', {
      baseRevision: 1, title: '原标题', handlingDurationMs: 60_000, fileId: 'replacement', replaceNoticeId: 'notice'
    });
    expect(publishCrisis).toHaveBeenCalledWith('card', 2, expect.any(String));
  });

  it('retains local edits and does not publish if saving is rejected', async () => {
    const {updateCrisisCard, publishCrisis} = await mount({failSave: true});
    const input = host.querySelector<HTMLInputElement>('input[aria-label="危机标题"]')!;
    await enter(input, '本地修改');
    await act(async () => publishButton().click());
    expect(updateCrisisCard).toHaveBeenCalledTimes(1);
    expect(publishCrisis).not.toHaveBeenCalled();
    expect(input.value).toBe('本地修改');
    expect(input.disabled).toBe(false);
    expect(host.textContent).toContain('未发布');
  });
});
