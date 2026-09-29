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
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

function client(overrides: Partial<SelfHostedApi>): SelfHostedApi {return overrides as SelfHostedApi;}

describe('delegate file portal', () => {
  it('clears the dot before the server replies and keeps later publications unread', async () => {
    const file = (id: string, publishedAt: string) => ({id, logicalName: id, fileType: 'NEWS' as const,
      publishedAt, submissionSource: 'CHAIR' as const, submitterDisplayName: null, submittedAt: null, revision: 1});
    const snapshot = {committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '委员会',
      shareId: 'share', claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true,
      storageAvailable: true, eventSequence: 0, maxUploadSizeBytes: 20 * 1024 * 1024,
      files: [file('first', '2026-09-29T01:00:00Z')], categoryOpenedAt: {}};
    const open = vi.fn(() => new Promise<{category: 'NEWS'; openedAt: string}>(() => {}));
    await act(async () => root.render(<DelegateFilePortal api={client({
      bootstrapDelegatePortal: async () => snapshot,
      openDelegatePublishedCategory: open as SelfHostedApi['openDelegatePublishedCategory']})} />));
    const menu = host.querySelector('[aria-label="已发布文件分类"]')!;
    const news = () => Array.from(menu.querySelectorAll('a')).find(item => item.textContent === '新闻') as HTMLElement;
    expect(news().querySelector('.delegate-file-category-dot')).not.toBeNull();
    await act(async () => news().click());
    expect(open).toHaveBeenCalledWith('NEWS', 'first', expect.any(AbortSignal));
    expect(news().querySelector('.delegate-file-category-dot')).toBeNull();
    await act(async () => FakeEventSource.latest!.emit('file.available', {id: 1, fileId: 'first',
      submissionSource: 'CHAIR', logicalName: 'first', publishedAt: '2026-09-29T01:00:00Z'}));
    expect(news().querySelector('.delegate-file-category-dot')).toBeNull();
    snapshot.files.push(file('second', '2026-09-29T02:00:00Z'));
    await act(async () => FakeEventSource.latest!.emit('file.available', {id: 2, fileId: 'second',
      submissionSource: 'CHAIR', logicalName: 'second', publishedAt: '2026-09-29T02:00:00Z'}));
    expect(news().querySelector('.delegate-file-category-dot')).not.toBeNull();
  });

  it('silently stops after five failed read updates without restoring the dot', async () => {
    const open = vi.fn(async () => {throw new Error('network');});
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '委员会', shareId: 'share',
      claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true, storageAvailable: true,
      eventSequence: 0, maxUploadSizeBytes: 20 * 1024 * 1024, categoryOpenedAt: {},
      files: [{id: 'news', logicalName: 'news', fileType: 'NEWS' as const, publishedAt: '2026-09-29T01:00:00Z',
        submissionSource: 'CHAIR' as const, submitterDisplayName: null, submittedAt: null, revision: 1}]}),
      openDelegatePublishedCategory: open as SelfHostedApi['openDelegatePublishedCategory']})} />));
    vi.useFakeTimers();
    const menu = host.querySelector('[aria-label="已发布文件分类"]')!;
    const news = Array.from(menu.querySelectorAll('a')).find(item => item.textContent === '新闻') as HTMLElement;
    await act(async () => news.click());
    expect(news.querySelector('.delegate-file-category-dot')).toBeNull();
    await act(async () => {await vi.advanceTimersByTimeAsync(16_000);});
    expect(open).toHaveBeenCalledTimes(5);
    expect(news.querySelector('.delegate-file-category-dot')).toBeNull();
    expect(host.querySelector('.error.message')).toBeNull();
  });

  it('marks only categories with approvals since their last opening and groups custom types under Other', async () => {
    const makeFile = (id: string, fileType: 'NEWS' | 'DIRECTIVE_DRAFT' | `CUSTOM:${string}`, publishedAt: string) => ({
      id, logicalName: id, fileType, publishedAt, submissionSource: 'CHAIR' as const,
      submitterDisplayName: null, submittedAt: null, revision: 1});
    const snapshot = {committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '委员会',
      shareId: 'share', claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true,
      storageAvailable: true, eventSequence: 0, maxUploadSizeBytes: 20 * 1024 * 1024,
      files: [makeFile('news', 'NEWS', '2026-09-29T01:00:00Z'),
        makeFile('directive', 'DIRECTIVE_DRAFT', '2026-09-29T01:00:00Z'),
        makeFile('custom-a', 'CUSTOM:快讯', '2026-09-29T01:00:00Z'),
        makeFile('custom-b', 'CUSTOM:快訊', '2026-09-29T01:00:00Z')],
      categoryOpenedAt: {DIRECTIVE_DRAFT: '2026-09-29T02:00:00Z'} as Record<string, string>};
    const opened = vi.fn(async (category: string) => {
      snapshot.categoryOpenedAt[category] = '2026-09-29T02:00:00Z';
      return {category, openedAt: snapshot.categoryOpenedAt[category]!};
    });
    await act(async () => root.render(<DelegateFilePortal api={client({
      bootstrapDelegatePortal: async () => snapshot,
      openDelegatePublishedCategory: opened as SelfHostedApi['openDelegatePublishedCategory']})} />));
    const menu = host.querySelector('[aria-label="已发布文件分类"]')!;
    const item = (label: string) => Array.from(menu.querySelectorAll('a')).find(link => link.textContent === label) as HTMLElement;
    const hasDot = (label: string) => Boolean(item(label).querySelector('.delegate-file-category-dot'));
    expect(hasDot('全部文件')).toBe(false);
    expect(hasDot('新闻')).toBe(true);
    expect(hasDot('指令草案')).toBe(false);
    expect(hasDot('其他')).toBe(true);
    await act(async () => item('新闻').click());
    expect(opened).toHaveBeenCalledWith('NEWS', 'news', expect.any(AbortSignal));
    expect(hasDot('新闻')).toBe(false);
    expect(hasDot('其他')).toBe(true);
    await act(async () => item('其他').click());
    expect(opened).toHaveBeenCalledWith('OTHER', 'custom-a', expect.any(AbortSignal));
    expect(hasDot('其他')).toBe(false);
    snapshot.files.push(makeFile('later-custom', 'CUSTOM:另一类', '2026-09-29T03:00:00Z'));
    await act(async () => FakeEventSource.latest!.emit('file.available', {
      id: 1, fileId: 'later-custom', submissionSource: 'CHAIR', submitterDisplayName: null,
      logicalName: 'later-custom', publishedAt: '2026-09-29T03:00:00Z'}));
    expect(hasDot('其他')).toBe(true);
    expect(hasDot('全部文件')).toBe(false);
    expect(host.textContent).toContain('主席 代表提交的 later-custom 现已可用。');
  });

  it('filters published files by fixed type and groups exact custom types under Other', async () => {
    const makeFile = (id: string, fileType: 'NEWS' | 'CRISIS_NOTICE' | `CUSTOM:${string}`) => ({
      id, logicalName: id, fileType, submissionSource: 'DELEGATE_PORTAL' as const, submitterDisplayName: '中国',
      submittedAt: '2026-09-29T00:00:00Z', publishedAt: '2026-09-29T01:00:00Z', revision: 1});
    const files = [makeFile('news', 'NEWS'), makeFile('crisis', 'CRISIS_NOTICE'),
      makeFile('alpha', 'CUSTOM:快讯'), makeFile('beta', 'CUSTOM:快讯'), makeFile('gamma', 'CUSTOM:快訊')];
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '委员会', shareId: 'share',
      claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true, storageAvailable: true,
      eventSequence: 0, files, categoryOpenedAt: {}, maxUploadSizeBytes: 20 * 1024 * 1024}),
      openDelegatePublishedCategory: async category => ({category, openedAt: '2026-09-29T02:00:00.000Z'})})} />));
    const menu = host.querySelector('[aria-label="已发布文件分类"]')!;
    expect(host.querySelectorAll('.delegate-file-card-list .card')).toHaveLength(5);
    await act(async () => (Array.from(menu.querySelectorAll('a')).find(item => item.textContent === '新闻') as HTMLElement).click());
    expect(Array.from(host.querySelectorAll('.delegate-file-card-list .card')).map(item => item.textContent)).toEqual([expect.stringContaining('news')]);
    await act(async () => (Array.from(menu.querySelectorAll('a')).find(item => item.textContent === '其他') as HTMLElement).click());
    expect(Array.from(host.querySelectorAll('.delegate-file-card-list .card')).map(item => item.querySelector('.header')?.textContent)).toEqual(['alpha', 'beta', 'gamma']);
    expect(host.textContent).toContain('快讯'); expect(host.textContent).toContain('快訊');
  });
  it('keeps unsaved and failed uploads out of the reviewed file history', async () => {
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '委员会', shareId: 'share',
      claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true, storageAvailable: false,
      eventSequence: 0, files: [], categoryOpenedAt: {}, submissions: [], maxUploadSizeBytes: 20 * 1024 * 1024,
      pendingUploads: [{id: 'saving', logicalName: '保存中.txt', status: 'SAVING'},
        {id: 'failed', logicalName: '失败.txt', status: 'FAILED'}]
    })})} />));
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '上传文件') as HTMLElement).click());
    expect(host.textContent).toContain('正在保存');
    expect(host.textContent).toContain('保存失败');
    expect(host.textContent).toContain('文件存储暂不可用');
    expect(host.textContent).not.toContain('等待审核');
    expect(host.querySelectorAll('.delegate-file-card-list .card')).toHaveLength(0);
  });

  it('blocks oversized files before hashing or upload and allows a replacement exactly at the runtime limit', async () => {
    const limit = 32 * 1024 * 1024;
    const hash = vi.spyOn(hashing, 'sha256File').mockResolvedValue('a'.repeat(64));
    const createDelegateFileUpload = vi.fn(async () => ({id:'upload'}));
    const uploadDelegateFileContent = vi.fn(async () => ({}));
    const commitDelegateFileUpload = vi.fn(async () => ({}));
    await act(async () => root.render(<DelegateFilePortal api={client({
      bootstrapDelegatePortal:async () => ({committeeId:'committee',committeeLanguage: 'zh-CN' as const, committeeName:'委员会',shareId:'share',
        claimedSeat:{id:'seat',displayName:'中国'},eligibleSeats:[],mayUpload:true,storageAvailable:true,
        eventSequence:0,files:[],categoryOpenedAt:{},maxUploadSizeBytes:limit}),
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
    expect((host.querySelector('form button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(hash).not.toHaveBeenCalled();
    expect(createDelegateFileUpload).not.toHaveBeenCalled();
    expect(uploadDelegateFileContent).not.toHaveBeenCalled();
    expect(commitDelegateFileUpload).not.toHaveBeenCalled();
    await choose(limit);
    expect(host.textContent).not.toContain('文件大小超出上限');
    expect((host.querySelector('form button') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => (host.querySelector('form button') as HTMLButtonElement).click());
    expect(hash).toHaveBeenCalledTimes(1);
    expect(createDelegateFileUpload).toHaveBeenCalledWith(expect.objectContaining({expectedSizeBytes:limit}));
    expect(uploadDelegateFileContent).toHaveBeenCalledTimes(1);
  });

  it('requires a second confirmation before binding the browser to a delegation', async () => {
    const claimDelegatePortal = vi.fn(async () => ({committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '裁军委员会', shareId: 'share',
      claimedSeat: {id: 'seat', displayName: '中国'}, eligibleSeats: [], mayUpload: true, storageAvailable: true,
      eventSequence: 0, files: [], categoryOpenedAt: {}, maxUploadSizeBytes: 20 * 1024 * 1024}));
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal: async () => ({
      committeeId: 'committee', committeeLanguage: 'zh-CN' as const, committeeName: '裁军委员会', shareId: 'share', claimedSeat: null,
      eligibleSeats: [{id: 'seat', displayName: '中国', flag: {type: 'STANDARD', value: 'cn'}}], mayUpload: false, storageAvailable: true,
      eventSequence: 0, files: [], categoryOpenedAt: {}, maxUploadSizeBytes: 20 * 1024 * 1024}), claimDelegatePortal})} />));
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
      eligibleSeats:[],mayUpload:true,storageAvailable:true,eventSequence:9,files:[],categoryOpenedAt:{},submissions:[submission],maxUploadSizeBytes:32*1024*1024})})} />));
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
      eligibleSeats: [], mayUpload: true, storageAvailable: true, eventSequence: 9, files: [file], categoryOpenedAt: {}, maxUploadSizeBytes: 20 * 1024 * 1024}),
      listDelegatePublishedFiles: async () => [file]})} />));
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '上传文件') as HTMLElement).click());
    expect(host.textContent).toContain('文件大小上限为 20 MiB');
    expect(host.textContent).toMatch(/选择文件\s*文件大小上限为 20 MiB/);
    await act(async () => (Array.from(host.querySelectorAll('a')).find(item => item.textContent === '已发布文件') as HTMLElement).click());
    await act(async () => FakeEventSource.latest?.emit('file.available', {id: 10, fileId: 'file',
      submissionSource: 'DELEGATE_PORTAL', submitterDisplayName: '中国', logicalName: '决议草案 1.1', publishedAt: file.publishedAt}));
    expect(host.textContent).toContain('中国 代表提交的 决议草案 1.1 现已可用。');
    const download = Array.from(host.querySelectorAll('a')).find(item => item.textContent?.includes('下载')) as HTMLAnchorElement;
    download.addEventListener('click', event => event.preventDefault(), {once: true});
    await act(async () => download.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
    expect(host.textContent).not.toContain('中国 代表提交的 决议草案 1.1 现已可用。');
  });

  it('shows the same chair banner when polling finds a publication missed by the stream', async () => {
    vi.useFakeTimers();
    const files = [{id: 'existing', submissionSource: 'CHAIR' as const, logicalName: '新闻 1.1',
      submitterDisplayName: null, fileType: 'NEWS' as const, submittedAt: null,
      publishedAt: '2026-09-29T01:00:00Z', revision: 1}];
    const bootstrapDelegatePortal = vi.fn(async () => ({committeeId: 'committee', committeeLanguage: 'zh-CN' as const,
      committeeName: '委员会', shareId: 'share', claimedSeat: {id: 'seat', displayName: '中国'},
      eligibleSeats: [], mayUpload: true, storageAvailable: true, eventSequence: 1, files: [...files],
      categoryOpenedAt: {}, maxUploadSizeBytes: 20 * 1024 * 1024}));
    await act(async () => root.render(<DelegateFilePortal api={client({bootstrapDelegatePortal})} />));
    expect(host.querySelector('.info.message')).toBeNull();
    files.push({id: 'new', submissionSource: 'CHAIR', logicalName: '即时消息 1.1',
      submitterDisplayName: null, fileType: 'NEWS', submittedAt: null,
      publishedAt: '2026-09-29T02:00:00Z', revision: 1});
    await act(async () => {await vi.advanceTimersByTimeAsync(15_000);});
    expect(host.querySelector('.info.message')?.textContent).toBe('主席 代表提交的 即时消息 1.1 现已可用。');
    expect(host.textContent).toContain('即时消息 1.1');
    await act(async () => {await vi.advanceTimersByTimeAsync(15_000);});
    expect(host.querySelectorAll('.info.message')).toHaveLength(1);
    files[0] = {...files[0], logicalName: '新闻 1.2', publishedAt: '2026-09-29T03:00:00Z'};
    await act(async () => {await vi.advanceTimersByTimeAsync(15_000);});
    expect(host.textContent).toContain('主席 代表提交的 新闻 1.2 现已可用。');
  });
});
