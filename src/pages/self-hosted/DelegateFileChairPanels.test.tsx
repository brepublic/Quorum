import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, DelegateReviewFile} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {DelegateFilePanels, DelegateFileUploadPanel} from './DelegateFileChairPanels';

vi.mock('qrcode', () => ({default: {toDataURL: vi.fn(async () => 'data:image/png;base64,qr')}}));

const reviewFile: DelegateReviewFile = {id: 'file', logicalName: '原文件.md', originalName: 'original.md', sizeBytes: 3,
  status: 'PENDING_REVIEW', submissionSource: 'DELEGATE_PORTAL', submitterDisplayName: '中国', fileType: 'WORKING_PAPER',
  submittedAt: '2026-08-28T00:00:00.000Z', publishedAt: '', revision: 1};
const publishedFile: DelegateReviewFile = {...reviewFile, id: 'published-file', logicalName: 'approved-file.pdf',
  originalName: 'approved.pdf', status: 'PUBLISHED', publishedAt: '2026-08-28T01:00:00.000Z', revision: 2};
const snapshot = {committee: {id: 'committee', committeeLanguage: 'zh-CN'}, sync: {committeeEventSequence: 1}} as CommitteeWorkspaceSnapshot;

let host: HTMLDivElement; let root: Root;
beforeEach(() => {setLanguage('zh-CN');host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;});
afterEach(async () => {await act(async () => root.unmount()); host.remove();});

describe('delegate file chair review', () => {
  it('keeps the upload component separate from review cards', async () => {
    const api = {createFileUpload: vi.fn(), uploadFileContent: vi.fn(), commitFileUpload: vi.fn()} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFileUploadPanel snapshot={snapshot} api={api} />));
    expect(host.querySelector('.delegate-file-chair-upload')).not.toBeNull();
    expect(host.querySelector('.delegate-file-card-list')).toBeNull();
    expect(host.textContent).toContain('上传文件');
  });

  it.each(['en', 'zh-CN'] as const)('keeps file content in %s while switching interface language', async committeeLanguage => {
    const pending = {...reviewFile, suggestedNames: {WORKING_PAPER: {sessionOrdinal: 2, ordinal: 3},
      DIRECTIVE_DRAFT: {sessionOrdinal: 2, ordinal: 1}, RESOLUTION_DRAFT: {sessionOrdinal: 2, ordinal: 1}}};
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles: async () => [pending]} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels tab="review" api={api}
      snapshot={{...snapshot, committee: {...snapshot.committee, committeeLanguage}}} />));
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe(committeeLanguage === 'en' ? 'Working paper 2.3' : '工作文件 2.3');
    await act(async () => setLanguage('en'));
    expect(host.textContent).toContain('Submitted at');
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe(committeeLanguage === 'en' ? 'Working paper 2.3' : '工作文件 2.3');
    await act(async () => setLanguage('zh-CN'));
    expect(host.textContent).toContain('提交时间');
    expect(input.value).toBe(committeeLanguage === 'en' ? 'Working paper 2.3' : '工作文件 2.3');
  });

  it('suggests names, offers preset rejection messages, and defaults to keeping bytes', async () => {
    const pending = {...reviewFile,suggestedNames:{WORKING_PAPER:{sessionOrdinal:1,ordinal:2},DIRECTIVE_DRAFT:{sessionOrdinal:1,ordinal:1},RESOLUTION_DRAFT:{sessionOrdinal:1,ordinal:1}}};
    const rejectDelegateFile = vi.fn(async () => ({})); const deleteFile = vi.fn();
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles:async () => [pending],rejectDelegateFile,deleteFile,
      getDelegateFileSettings:async () => ({rejectionTypes:[{id:'format',label:{'zh-CN':'内容格式不合要求'},message:{'zh-CN':'文件内容格式不合要求，请参阅《学术指引》修改后重新提交。'},custom:false}]})} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels tab="review" snapshot={snapshot} api={api} />));
    expect((host.querySelector('input[aria-label="文件名称"]') as HTMLInputElement).value).toBe('工作文件 1.2');
    await act(async () => (Array.from(host.querySelectorAll('button')).find(x => x.textContent==='驳回') as HTMLElement).click());
    expect(rejectDelegateFile).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('文件内容格式不合要求，请参阅《学术指引》修改后重新提交。');
    await act(async () => (Array.from(document.body.querySelectorAll('button')).find(x => x.textContent==='确认驳回') as HTMLElement).click());
    expect(rejectDelegateFile).toHaveBeenCalledWith('file',1,'工作文件 1.2','WORKING_PAPER',undefined,'format');
    expect(document.body.textContent).toContain('是否删除被驳回的文件？');
    expect(deleteFile).not.toHaveBeenCalled();
    await act(async () => (Array.from(document.body.querySelectorAll('button')).find(x => x.textContent==='保留文件') as HTMLElement).click());
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('keeps rendering after editing a review file name', async () => {
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles: async () => [reviewFile, publishedFile]} as unknown as SelfHostedApi;
    await act(async () => {root.render(<DelegateFilePanels tab="review" snapshot={snapshot} api={api} />);
      await new Promise(resolve => setTimeout(resolve, 0));});
    const input = host.querySelector('input[aria-label="文件名称"]') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    expect(valueSetter).toBeDefined();
    await act(async () => {valueSetter!.call(input, '中文 A.md');
      input.dispatchEvent(new Event('input', {bubbles: true}));});
    expect(input.value).toBe('中文 A.md');
    expect(host.textContent).toContain('批准');
    expect(host.textContent).not.toContain('待审核文件');
    expect(host.textContent).not.toContain('已审核文件');
    expect(host.querySelector('.delegate-file-review-divider')).not.toBeNull();
    expect(host.textContent).toContain('approved-file.pdf');
    expect(host.textContent).not.toContain('审核结果');
    expect(host.textContent).toContain('已批准');
    expect(host.querySelector('.motion-decision-passed')).not.toBeNull();
    expect(host.querySelectorAll('.motion-metadata-table .motion-metadata-key')).toHaveLength(9);
  });

  it('sorts 待审核文件按提交时间从早到晚', async () => {
    const earliest = {...reviewFile, id: 'first', logicalName: '最早文件.md', submittedAt: '2026-09-01T00:00:00.000Z'};
    const middle = {...reviewFile, id: 'middle', logicalName: '中间文件.md', submittedAt: '2026-09-02T00:00:00.000Z', status: 'UPLOAD_COMPLETE' as const};
    const latest = {...reviewFile, id: 'last', logicalName: '最新文件.md', submittedAt: '2026-09-03T00:00:00.000Z'};
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles: async () => [middle, earliest, latest]} as unknown as SelfHostedApi;
    await act(async () => {root.render(<DelegateFilePanels tab="review" snapshot={snapshot} api={api} />);
      await new Promise(resolve => setTimeout(resolve, 0));});
    const pendingCards = host.querySelectorAll('.delegate-file-card-list')[0]?.querySelectorAll('.delegate-file-card') ?? [];
    const names = Array.from(pendingCards).map(card => {
      const input = card.querySelector('input[aria-label="文件名称"]') as HTMLInputElement | null;
      return input?.value;
    }).filter(Boolean) as string[];
    expect(names).toEqual(['最早文件.md', '中间文件.md', '最新文件.md']);
  });

  it('sorts 已审核文件按提交时间从晚到早', async () => {
    const latest = {...publishedFile, id: 'reviewed-latest', logicalName: '最新审核文件.pdf', submittedAt: '2026-09-03T00:00:00.000Z'};
    const middle = {...publishedFile, id: 'reviewed-middle', logicalName: '中间审核文件.pdf', submittedAt: '2026-09-02T00:00:00.000Z', status:'REJECTED' as const};
    const earliest = {...publishedFile, id: 'reviewed-earliest', logicalName: '最早审核文件.pdf', submittedAt: '2026-09-01T00:00:00.000Z'};
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles: async () => [middle, latest, earliest]} as unknown as SelfHostedApi;
    await act(async () => {root.render(<DelegateFilePanels tab="review" snapshot={snapshot} api={api} />);
      await new Promise(resolve => setTimeout(resolve, 0));});
    const reviewedCards = host.querySelectorAll('.delegate-file-card-list')[1]?.querySelectorAll('.delegate-file-card') ?? [];
    const names = Array.from(reviewedCards).map(card => {
      const header = card.querySelector('.motion-heading .header') as HTMLElement | null;
      return header?.textContent?.trim();
    }).filter(Boolean) as string[];
    expect(names).toEqual(['最新审核文件.pdf', '中间审核文件.pdf', '最早审核文件.pdf']);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const activeShare = {id: 'share', url: 'https://example.test/delegate-files#test', revision: 1} as
  NonNullable<Awaited<ReturnType<SelfHostedApi['getDelegateFileShare']>>>;

describe('prefetched chair file data', () => {
  it('loads both resources before either tab is opened and keeps content during refresh', async () => {
    const nextShare = deferred<typeof activeShare>(); const nextFiles = deferred<DelegateReviewFile[]>();
    const getDelegateFileShare = vi.fn().mockResolvedValueOnce(activeShare).mockReturnValue(nextShare.promise);
    const listDelegateReviewFiles = vi.fn().mockResolvedValueOnce([publishedFile]).mockReturnValue(nextFiles.promise);
    const api = {getDelegateFileShare, listDelegateReviewFiles} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="upload" />));
    expect(getDelegateFileShare).toHaveBeenCalledTimes(1);
    expect(listDelegateReviewFiles).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('');
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="share" />));
    expect(host.querySelector('input')?.value).toBe(activeShare.url);
    expect(host.querySelector('img')).not.toBeNull();
    expect(host.textContent).not.toContain('开始分享');
    expect(getDelegateFileShare).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="review" />));
    expect(host.textContent).toContain(publishedFile.logicalName);
    expect(host.textContent).not.toContain('暂无已审核文件');
    expect(listDelegateReviewFiles).toHaveBeenCalledTimes(2);
    await act(async () => nextFiles.resolve([]));
    expect(host.textContent).toContain('暂无已审核文件');
  });

  it.each(['share', 'review'])('does not render false empty state while %s is loading or failed', async tab => {
    const pending = deferred<never>();
    const api = {getDelegateFileShare: () => pending.promise, listDelegateReviewFiles: () => pending.promise} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab={tab} />));
    expect(host.textContent).not.toMatch(/开始分享|暂无/);
    await act(async () => pending.reject(new Error('load failed')));
    expect(host.textContent).toContain('请求失败，请稍后重试。');
    expect(host.textContent).toContain('重试');
    expect(host.textContent).not.toMatch(/开始分享|暂无/);
  });

  it('retains loaded content on a refresh failure and retries', async () => {
    const listDelegateReviewFiles = vi.fn().mockResolvedValueOnce([publishedFile])
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="review" />));
    await act(async () => root.render(<DelegateFilePanels snapshot={{...snapshot, sync: {...snapshot.sync, committeeEventSequence: 2}}} api={api} tab="review" />));
    expect(host.textContent).toContain(publishedFile.logicalName);
    expect(host.textContent).toContain('请求失败，请稍后重试。');
    await act(async () => (Array.from(host.querySelectorAll('button')).find(button => button.textContent === '重试') as HTMLButtonElement).click());
    expect(host.textContent).toContain('暂无已审核文件');
    expect(host.textContent).not.toContain('请求失败，请稍后重试。');
  });

  it('ignores an older response after a realtime refresh', async () => {
    const old = deferred<DelegateReviewFile[]>();
    const listDelegateReviewFiles = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce([publishedFile]);
    const api = {getDelegateFileShare: async () => null, listDelegateReviewFiles} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="review" />));
    await act(async () => root.render(<DelegateFilePanels snapshot={{...snapshot, sync: {...snapshot.sync, committeeEventSequence: 2}}} api={api} tab="review" />));
    await act(async () => old.resolve([]));
    expect(host.textContent).toContain(publishedFile.logicalName);
  });

  it('does not restore a share from a pending read after ending it', async () => {
    const old = deferred<typeof activeShare>();
    const api = {getDelegateFileShare: vi.fn().mockResolvedValueOnce(activeShare).mockReturnValueOnce(old.promise),
      listDelegateReviewFiles: async () => [], endDelegateFileShare: vi.fn(async () => null)} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="review" />));
    await act(async () => root.render(<DelegateFilePanels snapshot={snapshot} api={api} tab="share" />));
    await act(async () => (Array.from(host.querySelectorAll('button')).find(button => button.textContent === '结束分享') as HTMLButtonElement).click());
    await act(async () => old.resolve(activeShare));
    expect(host.textContent).toContain('开始分享');
    expect(host.querySelector('input')).toBeNull();
  });
});
