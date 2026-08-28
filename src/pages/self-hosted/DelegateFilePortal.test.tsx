import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import DelegateFilePortal from './DelegateFilePortal';

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  listeners = new Map<string, EventListener>();
  constructor(readonly url: string) {FakeEventSource.latest = this;}
  addEventListener(type: string, listener: EventListener) {this.listeners.set(type, listener);}
  close() {}
  emit(type: string, data: unknown) {this.listeners.get(type)?.({data: JSON.stringify(data)} as unknown as Event);}
}

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  window.location.hash = '#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();});

function client(overrides: Partial<SelfHostedApi>): SelfHostedApi {return overrides as SelfHostedApi;}

describe('delegate file portal', () => {
  it('requires a second confirmation before binding the browser to a delegation', async () => {
    const claimDelegatePortal = vi.fn(async () => ({committeeId: 'committee', committeeName: '裁军委员会', shareId: 'share',
      claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true, chairHostHealthy: true,
      eventSequence: 0, files: []}));
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeName: '裁军委员会', shareId: 'share', claimedSeat: null,
      eligibleSeats: [{id: 'seat', displayName: '中国'}], mayUpload: false, chairHostHealthy: true,
      eventSequence: 0, files: []}), claimDelegatePortal})} />));
    const select = host.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => select.dispatchEvent(new MouseEvent('click', {bubbles: true})));
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(item => item.textContent === '中国') as HTMLElement;
    await act(async () => option.dispatchEvent(new MouseEvent('click', {bubbles: true})));
    const firstConfirm = Array.from(host.querySelectorAll('button')).find(item => item.textContent === '确认') as HTMLButtonElement;
    await act(async () => firstConfirm.click());
    expect(document.body.textContent).toContain('确认后不可更改代表团身份。');
    expect(claimDelegatePortal).not.toHaveBeenCalled();
    const finalConfirm = Array.from(document.body.querySelectorAll('button')).filter(item => item.textContent === '确认').at(-1) as HTMLButtonElement;
    await act(async () => finalConfirm.click());
    expect(claimDelegatePortal).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'seat');
  });

  it('shows the exact SSE publication banner and dismisses it on matching download', async () => {
    const file = {id: 'file', logicalName: '决议草案 1.1', submitterDisplayName: '中国', fileType: 'RESOLUTION_DRAFT' as const,
      submittedAt: '2026-08-27T10:00:00.000Z', publishedAt: '2026-08-27T10:01:00.000Z', revision: 2};
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeName: '裁军委员会', shareId: 'share', claimedSeat: {id: 'seat', displayName: '法国'},
      eligibleSeats: [], mayUpload: true, chairHostHealthy: true, eventSequence: 9, files: [file]}),
      listDelegatePublishedFiles: async () => [file]})} />));
    await act(async () => FakeEventSource.latest?.emit('file.available', {id: 10, fileId: 'file',
      submitterDisplayName: '中国', logicalName: '决议草案 1.1', publishedAt: file.publishedAt}));
    expect(host.textContent).toContain('中国 代表 提交的 决议草案 1.1 现已可用。');
    const download = Array.from(host.querySelectorAll('a')).find(item => item.textContent?.includes('下载')) as HTMLAnchorElement;
    download.addEventListener('click', event => event.preventDefault(), {once: true});
    await act(async () => download.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
    expect(host.textContent).not.toContain('中国 代表 提交的 决议草案 1.1 现已可用。');
  });
});
