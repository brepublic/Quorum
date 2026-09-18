import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import OperationsPanel from './OperationsPanel';

beforeEach(() => setLanguage('zh-CN'));

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });

describe('operations status panel', () => {
  it('shows capacity and fixed queue aggregates without operational paths', async () => {
    const api = {operationsStatus: vi.fn(async () => ({database: {schemaCompatibility: 26, serverTime: '2026-08-14T00:00:00Z'},
      storage: {state: 'warning' as const, usageRatio: 0.82, availableBytes: 100},
      accounts: {active: 2, disabled: 1, anonymized: 0}, committees: {active: 1, paused: 0, archived: 2, deleting: 0},
      queues: {blobDelete: 3, uploadStaging: 0, migration: 0, agentTasks: 2, committeeDeletion: 0},
      retention: {lastStatus: 'COMPLETED', lastCompletedAt: '2026-08-14T00:00:00Z'}}))};
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<OperationsPanel api={api as never} />); await Promise.resolve(); });
    expect(container.textContent).toContain('存储使用率 82%');
    expect(container.textContent).toContain('主席电脑任务');
    expect(container.textContent).not.toMatch(/storage_key|\/var\/lib|credential/i);
  });

  it('shows safe cache inventory in eviction order without a download action', async () => {
    const operations = {database: {schemaCompatibility: 50, serverTime: '2026-08-28T00:00:00Z'},
      storage: {state: 'normal' as const, usageRatio: 0.4, availableBytes: 100},
      accounts: {active: 1, disabled: 0, anonymized: 0}, committees: {active: 1, paused: 0, archived: 0, deleting: 0},
      queues: {blobDelete: 0, uploadStaging: 0, migration: 0, agentTasks: 0, committeeDeletion: 0},
      retention: {lastStatus: null, lastCompletedAt: null}};
    const config = {publishedCacheMaxBytes: 1_000, pendingReviewMaxBytes: 500,
      pendingReviewCommitteeMaxBytes: 250, storageMinFreeBytes: 100, storageMinFreePercent: 20, revision: 2,
      hardLimits: {publishedCacheMaxBytes: 2_000, pendingReviewMaxBytes: 1_000,
        pendingReviewCommitteeMaxBytes: 500, storageMinFreeBytes: 100, storageMinFreePercent: 20}};
    const api = {operationsStatus: vi.fn(async () => operations), storageCacheStatus: vi.fn(async () => ({config,
      capacity: {totalBytes: 4_000, availableBytes: 2_000, quorumBytes: 300,
        pendingReviewBytes: 100, publishedCacheBytes: 200, otherStagingBytes: 0},
      runtime: {hits: 3, misses: 1, refills: 1, fetching: 0, lastEvictedAt: null, lastEvictedBytes: 0}})),
    storageCacheFiles: vi.fn(async (state: 'published' | 'pending') => ({files: state === 'published' ? [{
      id: 'cache-1', committeeId: 'committee-1', committeeName: '测试委员会', fileEntryId: 'file-1',
      fileName: '第一份文件.pdf', sizeBytes: 200, state: 'READY' as const,
      cachedAt: '2026-08-28T00:00:00Z', lastAccessedAt: null}] : [{
        id: 'cache-2', committeeId: 'committee-1', committeeName: '测试委员会', fileEntryId: 'file-2',
        fileName: '待审核.docx', sizeBytes: 100, state: 'REVIEW_PINNED' as const,
        cachedAt: '2026-08-28T00:01:00Z', lastAccessedAt: null}], page: 1, pageSize: 25, total: 1})),
    updateStorageCacheConfig: vi.fn(async () => config)};
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => {root?.render(<OperationsPanel api={api as never} />); await Promise.resolve();});
    expect(container.textContent).toContain('第一份文件.pdf最先淘汰');
    expect(container.textContent).toContain('待审核.docx');
    expect(container.textContent).toContain('测试委员会');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelectorAll('details:not([open])')).toHaveLength(2);
    expect(api.updateStorageCacheConfig).not.toHaveBeenCalled();
    await act(async () => {container!.querySelector('button')!.click();});
    expect(api.operationsStatus).toHaveBeenCalledTimes(2);
    expect(api.storageCacheStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toMatch(/下载|storage_key|sha256|credential|\/var\/lib/i);
  });
});
