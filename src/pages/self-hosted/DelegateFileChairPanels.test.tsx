import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {CommitteeWorkspaceSnapshot, DelegateReviewFile} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {DelegateFileReviewPanel} from './DelegateFileChairPanels';

const reviewFile: DelegateReviewFile = {id: 'file', logicalName: '原文件.md', originalName: 'original.md', sizeBytes: 3,
  status: 'PENDING_REVIEW', submissionSource: 'DELEGATE_PORTAL', submitterDisplayName: '中国', fileType: 'WORKING_PAPER',
  submittedAt: '2026-08-28T00:00:00.000Z', publishedAt: '', revision: 1};
const snapshot = {committee: {id: 'committee'}, sync: {committeeEventSequence: 1}} as CommitteeWorkspaceSnapshot;

let host: HTMLDivElement; let root: Root;
beforeEach(() => {host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;});
afterEach(async () => {await act(async () => root.unmount()); host.remove();});

describe('delegate file chair review', () => {
  it('keeps rendering after editing a review file name', async () => {
    const api = {listDelegateReviewFiles: async () => [reviewFile]} as unknown as SelfHostedApi;
    await act(async () => {root.render(<DelegateFileReviewPanel snapshot={snapshot} api={api} />);
      await new Promise(resolve => setTimeout(resolve, 0));});
    const input = host.querySelector('input[aria-label="文件名称"]') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    expect(valueSetter).toBeDefined();
    await act(async () => {valueSetter!.call(input, '中文 A.md');
      input.dispatchEvent(new Event('input', {bubbles: true}));});
    expect(input.value).toBe('中文 A.md');
    expect(host.textContent).toContain('批准');
  });
});
