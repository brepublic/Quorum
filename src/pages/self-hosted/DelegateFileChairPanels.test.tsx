import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, DelegateReviewFile} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {DelegateFileReviewPanel} from './DelegateFileChairPanels';

const reviewFile: DelegateReviewFile = {id: 'file', logicalName: '原文件.md', originalName: 'original.md', sizeBytes: 3,
  status: 'PENDING_REVIEW', submissionSource: 'DELEGATE_PORTAL', submitterDisplayName: '中国', fileType: 'WORKING_PAPER',
  submittedAt: '2026-08-28T00:00:00.000Z', publishedAt: '', revision: 1};
const publishedFile: DelegateReviewFile = {...reviewFile, id: 'published-file', logicalName: 'approved-file.pdf',
  originalName: 'approved.pdf', status: 'PUBLISHED', publishedAt: '2026-08-28T01:00:00.000Z', revision: 2};
const snapshot = {committee: {id: 'committee'}, sync: {committeeEventSequence: 1}} as CommitteeWorkspaceSnapshot;

let host: HTMLDivElement; let root: Root;
beforeEach(() => {host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;});
afterEach(async () => {await act(async () => root.unmount()); host.remove();});

describe('delegate file chair review', () => {
  it('suggests names, offers preset rejection messages, and defaults to keeping bytes', async () => {
    const pending = {...reviewFile,suggestedNames:{WORKING_PAPER:'工作文件 1.2',DIRECTIVE_DRAFT:'指令草案 1.1',RESOLUTION_DRAFT:'决议草案 1.1'}};
    const rejectDelegateFile = vi.fn(async () => ({})); const deleteFile = vi.fn();
    const api = {listDelegateReviewFiles:async () => [pending],rejectDelegateFile,deleteFile,
      getDelegateFileSettings:async () => ({rejectionTypes:[{id:'format',label:'内容格式不合要求',message:'文件内容格式不合要求，请参阅《学术指引》修改后重新提交。',custom:false}]})} as unknown as SelfHostedApi;
    await act(async () => root.render(<DelegateFileReviewPanel snapshot={snapshot} api={api} />));
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
    const api = {listDelegateReviewFiles: async () => [reviewFile, publishedFile]} as unknown as SelfHostedApi;
    await act(async () => {root.render(<DelegateFileReviewPanel snapshot={snapshot} api={api} />);
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
});
