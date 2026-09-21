import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import DelegateFilePortal from './DelegateFilePortal';
import * as hashing from '../../services/sha256';

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
beforeEach(() => {setLanguage('zh-CN');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  window.location.hash = '#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

function client(overrides: Partial<SelfHostedApi>): SelfHostedApi {return overrides as SelfHostedApi;}

describe('delegate file portal', () => {
  it('blocks oversized files before hashing or upload and allows a replacement exactly at the runtime limit', async () => {
    const limit = 32 * 1024 * 1024;
    const hash = vi.spyOn(hashing, 'sha256File').mockResolvedValue('a'.repeat(64));
    const createDelegateFileUpload = vi.fn(async () => ({id:'upload'}));
    const uploadDelegateFileContent = vi.fn(async () => ({}));
    const commitDelegateFileUpload = vi.fn(async () => ({}));
    await act(async () => root.render(<DelegateFilePortal api={client({
      bootstrapDelegatePortal:async () => ({committeeId:'committee',committeeLanguage: 'zh-CN' as const, committeeName:'委员会',shareId:'share',
        claimedSeat:{id:'seat',displayName:'中国'},eligibleSeats:[],mayUpload:true,storageAvailable:true,
        eventSequence:0,files:[],maxUploadSizeBytes:limit}),
      createDelegateFileUpload,uploadDelegateFileContent,commitDelegateFileUpload
    } as unknown as Partial<SelfHostedApi>)} />));
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '上传文件') as HTMLElement).click());
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const choose = async (size: number) => {
      const file = new File(['test'], 'draft.pdf', {type:'application/pdf'});
      Object.defineProperty(file, 'size', {value:size});
      Object.defineProperty(input, 'files', {value:[file], configurable:true});
      await act(async () => input.dispatchEvent(new Event('change',{bubbles:true})));
    };
    await choose(limit + 1);
    expect(host.querySelector('.negative.message[role="alert"]')?.textContent).toContain('文件大小超出上限，请选择不超过 32 MiB 的文件。');
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(hash).not.toHaveBeenCalled();
    expect(createDelegateFileUpload).not.toHaveBeenCalled();
    expect(uploadDelegateFileContent).not.toHaveBeenCalled();
    expect(commitDelegateFileUpload).not.toHaveBeenCalled();
    await choose(limit);
    expect(host.textContent).not.toContain('文件大小超出上限');
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
    expect(hash).toHaveBeenCalledTimes(1);
    expect(createDelegateFileUpload).toHaveBeenCalledWith(expect.objectContaining({expectedSizeBytes:limit}));
    expect(uploadDelegateFileContent).toHaveBeenCalledTimes(1);
  });

  it('requires a second confirmation before binding the browser to a delegation', async () => {
    const claimDelegatePortal = vi.fn(async () => ({committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '裁军委员会', shareId: 'share',
      claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true, storageAvailable: true,
      eventSequence: 0, files: [], maxUploadSizeBytes: 20 * 1024 * 1024}));
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '裁军委员会', shareId: 'share', claimedSeat: null,
      eligibleSeats: [{id: 'seat', displayName: '中国', flag: {type: 'STANDARD', value: 'cn'}}], mayUpload: false, storageAvailable: true,
      eventSequence: 0, files: [], maxUploadSizeBytes: 20 * 1024 * 1024}), claimDelegatePortal})} />));
    const select = host.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => select.dispatchEvent(new MouseEvent('click', {bubbles: true})));
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(item => item.textContent === '中国') as HTMLElement;
    expect(option.querySelector('.country-flag-display')).not.toBeNull();
    await act(async () => option.dispatchEvent(new MouseEvent('click', {bubbles: true})));
    const firstConfirm = Array.from(host.querySelectorAll('button')).find(item => item.textContent === '确认') as HTMLButtonElement;
    await act(async () => firstConfirm.click());
    expect(document.body.textContent).toContain('确认后不可更改代表团身份。');
    expect(claimDelegatePortal).not.toHaveBeenCalled();
    const finalConfirm = Array.from(document.body.querySelectorAll('button')).filter(item => item.textContent === '确认').at(-1) as HTMLButtonElement;
    await act(async () => finalConfirm.click());
    expect(claimDelegatePortal).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'seat');
  });

  it('shows identity, runtime limit, rejection history and a red targeted banner', async () => {
    const submission = {id:'rejected',logicalName:'工作文件 3.1',originalName:'test.txt',sizeBytes:1,
      submitterDisplayName:'新加坡',fileType:'WORKING_PAPER' as const,status:'REJECTED' as const,
      submissionSource:'DELEGATE_PORTAL' as const,submittedAt:'2026-09-06T00:00:00Z',publishedAt:'',revision:3,
      rejectionReason:'请补充签署国',reviewedAt:'2026-09-06T01:00:00Z'};
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal:async () => ({
      committeeId:'committee',committeeLanguage: 'zh-CN' as const, committeeName:'委员会',shareId:'share',claimedSeat:{id:'seat',displayName:'新加坡'},
      eligibleSeats:[],mayUpload:true,storageAvailable:true,eventSequence:9,files:[],submissions:[submission],maxUploadSizeBytes:32*1024*1024})})} />));
    await act(async () => FakeEventSource.latest?.onopen?.());
    expect(host.querySelector('.right.menu')?.textContent).toMatch(/实时.*新加坡/);
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '上传文件') as HTMLElement).click());
    expect(host.textContent).toContain('文件大小上限为 32 MiB');
    expect(host.textContent).toContain('已驳回'); expect(host.textContent).toContain('请补充签署国');
    await act(async () => FakeEventSource.latest?.emit('file.rejected',{id:10,fileId:'rejected',kind:'rejected',
      submitterDisplayName:'新加坡',logicalName:'工作文件 3.1',rejectionReason:'请补充签署国'}));
    const banner = host.querySelector('.negative.message');
    expect(banner?.textContent).toBe('新加坡 提交的 工作文件 3.1 被主席驳回。请补充签署国');
    expect(Array.from(banner!.querySelectorAll('strong')).map(item=>item.textContent)).toEqual(['新加坡','工作文件 3.1']);
  });

  it('shows the exact SSE publication banner and dismisses it on matching download', async () => {
    const file = {id: 'file', submissionSource: 'DELEGATE_PORTAL' as const, logicalName: '决议草案 1.1', submitterDisplayName: '中国', fileType: 'RESOLUTION_DRAFT' as const,
      submittedAt: '2026-08-27T10:00:00.000Z', publishedAt: '2026-08-27T10:01:00.000Z', revision: 2};
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '裁军委员会', shareId: 'share', claimedSeat: {id: 'seat', displayName: '法国'},
      eligibleSeats: [], mayUpload: true, storageAvailable: true, eventSequence: 9, files: [file], maxUploadSizeBytes: 20 * 1024 * 1024}),
      listDelegatePublishedFiles: async () => [file]})} />));
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '上传文件') as HTMLElement).click());
    expect(host.textContent).toContain('文件大小上限为 20 MiB');
    expect(host.textContent).toMatch(/选择文件\s*文件大小上限为 20 MiB/);
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '已发布文件') as HTMLElement).click());
    await act(async () => FakeEventSource.latest?.emit('file.available', {id: 10, fileId: 'file',
      submitterDisplayName: '中国', logicalName: '决议草案 1.1', publishedAt: file.publishedAt}));
    expect(host.textContent).toContain('中国 代表提交的 决议草案 1.1 现已可用。');
    const download = Array.from(host.querySelectorAll('a')).find(item => item.textContent?.includes('下载')) as HTMLAnchorElement;
    download.addEventListener('click', event => event.preventDefault(), {once: true});
    await act(async () => download.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
    expect(host.textContent).not.toContain('中国 代表提交的 决议草案 1.1 现已可用。');
  });
});
