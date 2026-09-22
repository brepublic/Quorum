import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, FileEntry, StorageHost, StorageMigration} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {SelfHostedApiError} from '../../services/self-hosted-api';
import {MemoryRouter} from 'react-router-dom';
import FilesPanel, {storageErrorText} from './FilesPanel';

beforeEach(() => setLanguage('zh-CN'));

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const committeeId = '20000000-0000-4000-8000-000000000001';
const file: FileEntry = {id: '30000000-0000-4000-8000-000000000001', committeeId, logicalName: '工作文件一',
  mediaType: 'image/svg+xml', status: 'UPLOAD_COMPLETE', syncState: 'SYNCED', createdByUserId: 'member', revision: 1,
  currentVersion: {id: 'version', versionNumber: 1, originalName: 'draft.svg', mediaType: 'image/svg+xml',
    sizeBytes: 3, sha256: 'a'.repeat(64), blobId: 'blob', createdAt: '2026-08-13T00:00:00.000Z'},
  submittedAt: null, publishedAt: null, createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z'};

function snapshot(audience: CommitteeWorkspaceSnapshot['viewer']['audience'],
  status: CommitteeWorkspaceSnapshot['committee']['status'] = 'ACTIVE'): CommitteeWorkspaceSnapshot {
  return {schemaVersion: 3, committee: {committeeLanguage: 'en', id: committeeId, name: '安理会', chairLabel: '主席', topic: '', conference: '',
    visibility: audience === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE', operationMode: 'DELEGATE_OPERATED', status,
    activeRulePackageVersionId: 'rules', revision: 2}, seats: [], viewer: {audience, seatId: null}, attendance: [],
  motionSettings: {delegateMotionProposalsEnabled: false, delegateMotionVotingEnabled: false},
  layoutSettings: {moveQueueUp: false, timersInSeparateColumns: false},
  points: [], notes: [], textPosts: [], activeRules: {versionId: 'rules', activePhaseId: null, phases: [],
    attendanceResponses: [], pointTypes: [], motionTypes: [], speakerLists: [], ballots: {delegateMayChangeVote: false,
      chairMayCorrectVote: true, anonymousStrawpoll: false, mustCollectAllVotesWhenVetoSeatEligible: true},
    documents: {amendmentsPublicByDefault: false}}, sync: {committeeEventSequence: 1}};
}

function api(overrides: Partial<SelfHostedApi> = {}): SelfHostedApi {
  return {listFiles: vi.fn(async () => [file]), fileDownloadUrl: vi.fn(id => `/api/v1/files/${id}/download`),
    listPendingHostCommits: vi.fn(async () => []),
    listStorageBindings: vi.fn(async () => []), listS3ProviderConfigs: vi.fn(async () => []),
    listStorageHosts: vi.fn(async () => []),
    listStorageAgentConflicts: vi.fn(async () => []),
    listStorageMigrations: vi.fn(async () => []), ...overrides} as unknown as SelfHostedApi;
}

let root: Root | undefined; let container: HTMLDivElement | undefined;
async function render(audience: CommitteeWorkspaceSnapshot['viewer']['audience'], client: SelfHostedApi,
  currentUserId?: string, status: CommitteeWorkspaceSnapshot['committee']['status'] = 'ACTIVE'): Promise<HTMLDivElement> {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {root?.render(<MemoryRouter><FilesPanel snapshot={snapshot(audience, status)} api={client}
    currentUserId={currentUserId} /></MemoryRouter>); await new Promise(resolve => setTimeout(resolve, 0));});
  return container;
}
function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? []).find(item => item.textContent?.includes(label));
}
afterEach(() => {if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined;
  vi.restoreAllMocks();});

describe('self-hosted stage 6 file panel', () => {
  it.each([
    ['SERVICE_NOT_READY', '存储暂不可用'], ['REVISION_CONFLICT', '状态已更新'],
    ['IDEMPOTENCY_CONFLICT', '请求内容已变更'], ['FORBIDDEN', '没有权限'],
    ['PAYLOAD_TOO_LARGE', '文件过大'], ['RESOURCE_CONFLICT', '操作与最新记录冲突']
  ])('maps %s to a short recovery message', (code, expected) => {
    expect(storageErrorText(new SelfHostedApiError(409, code, 'internal message'))).toContain(expected);
  });

  it('keeps the role matrix authoritative and never previews dangerous file content', async () => {
    let view = await render('PUBLIC', api());
    expect(view.textContent).toContain('下载文件'); expect(view.textContent).not.toContain('上传文件');
    expect(view.textContent).not.toContain('提交审核'); expect(view.querySelector('iframe,object,embed,[src^="data:"]')).toBeNull();
    expect(view.querySelector('a')?.getAttribute('href')).toContain('/download');
    act(() => root?.unmount()); view.remove(); root = undefined; container = undefined;

    view = await render('MEMBER', api(), 'member');
    expect(view.textContent).toContain('上传文件'); expect(view.textContent).toContain('提交审核');
    expect(view.textContent).toContain('永久删除'); expect(view.textContent).not.toContain('文件存储');
    act(() => root?.unmount()); view.remove(); root = undefined; container = undefined;

    view = await render('CHAIR', api(), 'chair');
    expect(view.textContent).toContain('文件存储'); expect(view.textContent).toContain('提交审核');
    act(() => root?.unmount()); view.remove(); root = undefined; container = undefined;

    view = await render('MEMBER', api(), 'system-admin');
    expect(view.textContent).not.toContain('文件存储');
    expect(view.textContent).not.toContain('永久删除');
  });

  it('keeps archived committees download-only even for the Owner', async () => {
    const view = await render('OWNER', api(), 'owner', 'ARCHIVED');
    expect(view.textContent).toContain('下载文件');
    expect(view.textContent).not.toContain('上传文件');
    expect(view.textContent).not.toContain('提交审核');
    expect(view.textContent).not.toContain('永久删除');
    expect(view.textContent).not.toContain('文件存储');
  });

  it('hashes, streams, reports progress, commits, and refreshes a selected file', async () => {
    let committed = false;
    const createFileUpload = vi.fn(async () => ({id: 'upload', status: 'CREATED'}));
    const uploadFileContent = vi.fn(async (_id, _file, _key, options) => {
      options.onProgress?.(3, 3); return {id: 'upload', status: 'STAGED'};
    });
    const commitFileUpload = vi.fn(async () => {committed = true; return file;});
    const client = api({listFiles: vi.fn(async () => committed ? [file] : []), createFileUpload,
      uploadFileContent, commitFileUpload} as unknown as Partial<SelfHostedApi>);
    const view = await render('MEMBER', client, 'member');
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    const selected = new File(['abc'], 'working-paper.txt', {type: 'text/plain'});
    Object.defineProperty(input, 'files', {configurable: true, value: [selected]});
    await act(async () => {input.dispatchEvent(new Event('change', {bubbles: true}));});
    await act(async () => {button('上传文件')?.click(); await new Promise(resolve => setTimeout(resolve, 20));});
    expect(createFileUpload).toHaveBeenCalledWith(committeeId, expect.objectContaining({logicalName: 'working-paper.txt',
      originalName: 'working-paper.txt', expectedSizeBytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}), expect.any(String));
    expect(uploadFileContent).toHaveBeenCalledWith('upload', selected, expect.any(String), expect.objectContaining({
      signal: expect.any(AbortSignal), onProgress: expect.any(Function)}));
    expect(commitFileUpload).toHaveBeenCalledWith('upload', expect.any(String));
    expect(view.textContent).toContain('工作文件一');
  });

  it('keeps the selected file available for a retry after a recoverable provider failure', async () => {
    const uploadFileContent = vi.fn()
      .mockRejectedValueOnce(new SelfHostedApiError(503, 'SERVICE_NOT_READY', 'Provider failed.'))
      .mockResolvedValueOnce({id: 'upload-two', status: 'STAGED'});
    const client = api({listFiles: vi.fn(async () => []),
      createFileUpload: vi.fn().mockResolvedValueOnce({id: 'upload-one', status: 'CREATED'})
        .mockResolvedValueOnce({id: 'upload-two', status: 'CREATED'}), uploadFileContent,
      commitFileUpload: vi.fn(async () => file)} as unknown as Partial<SelfHostedApi>);
    const view = await render('MEMBER', client, 'member');
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {configurable: true, value: [new File(['abc'], 'draft.txt')]});
    await act(async () => {input.dispatchEvent(new Event('change', {bubbles: true}));});
    await act(async () => {button('上传文件')?.click(); await new Promise(resolve => setTimeout(resolve, 20));});
    expect(view.textContent).toContain('存储暂不可用');
    await act(async () => {button('上传文件')?.click(); await new Promise(resolve => setTimeout(resolve, 20));});
    expect(uploadFileContent).toHaveBeenCalledTimes(2);
  });

  it('reloads durable Chair Agent pending uploads and keeps them out of the file list', async () => {
    const pending = {id: 'pending-upload', committeeId, storageBindingId: 'agent-binding',
      logicalName: '离线文件', originalName: 'offline.pdf', mediaType: 'application/pdf', expectedSizeBytes: 8,
      receivedSizeBytes: 8, expectedSha256: 'b'.repeat(64), actualSha256: 'b'.repeat(64), status: 'STAGED',
      revision: 2, expiresAt: '2026-09-13T00:00:00.000Z', failureCode: null, committedFileEntryId: null,
      agentCommitState: 'PENDING_HOST_COMMIT', agentTaskId: 'task', createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'} as const;
    const view = await render('MEMBER', api({listFiles: vi.fn(async () => []),
      listPendingHostCommits: vi.fn(async () => [pending])}), 'member');
    expect(view.textContent).toContain('正在保存');
    expect(view.textContent).toContain('离线文件');
    expect(view.textContent).toContain('暂无文件');
  });

  it('shows when a transferred Chair host has not confirmed the current file revision', async () => {
    const view = await render('MEMBER', api({listFiles: vi.fn(async () => [
      {...file, syncState: 'OUT_OF_SYNC'} as FileEntry
    ])}),
      'member');
    expect(view.textContent).toContain('等待主席电脑同步');
  });

  it('offers Chair computer initialization only after an active host is paired', async () => {
    const createChairAgentBinding = vi.fn(async () => ({id: 'binding', committeeId,
      providerType: 'CHAIR_AGENT', providerConfigId: null, storageHostId: 'host', status: 'ACTIVE', revision: 1,
      createdAt: '2026-08-13T00:00:00.000Z'}));
    const client = api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [{id: 'host', committeeId,
      deviceId: 'device', deviceLabel: '主席电脑', leaseGeneration: 1, status: 'ACTIVE', revision: 1,
      lastSeenAt: '2026-08-13T00:00:00.000Z', pairedAt: '2026-08-13T00:00:00.000Z', revokedAt: null,
      agentProtocolVersion: null, capabilities: []}]),
      createChairAgentBinding} as unknown as Partial<SelfHostedApi>);
    const view = await render('OWNER', client, 'owner');
    expect(view.textContent).toContain('主席电脑');
    const select = view.querySelector('.ui.dropdown') as HTMLElement;
    await act(async () => {select.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    const option = Array.from(view.querySelectorAll('.item')).find(item => item.textContent === '主席电脑') as HTMLElement;
    await act(async () => {option?.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    await act(async () => {button('启用存储')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(createChairAgentBinding).toHaveBeenCalledWith(committeeId, 2);
  });

  it('creates a one-time pairing or transfer code only for a storage manager', async () => {
    const createStoragePairingCode = vi.fn(async () => ({code: 'QRM-ABCD-EFGH', purpose: 'INITIAL' as const,
      expiresAt: '2026-08-13T01:00:00.000Z'}));
    const manager = await render('CHAIR', api({listFiles: vi.fn(async () => []), createStoragePairingCode}), 'chair');
    await act(async () => {button('配对主席电脑')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(createStoragePairingCode).toHaveBeenCalledWith(committeeId, 2, 'INITIAL');
    expect(manager.textContent).toContain('QRM-ABCD-EFGH');
    act(() => root?.unmount()); manager.remove(); root = undefined; container = undefined;

    const member = await render('MEMBER', api({createStoragePairingCode}), 'member');
    expect(member.textContent).not.toContain('配对主席电脑');
    expect(createStoragePairingCode).toHaveBeenCalledTimes(1);
  });

  it('uses the loaded committee revision when transferring or revoking the active host', async () => {
    const host = {id: 'host', committeeId, deviceId: 'device', deviceLabel: '主席电脑', leaseGeneration: 1,
      status: 'DEGRADED' as const, revision: 2, lastSeenAt: '2026-08-13T00:00:00.000Z',
      pairedAt: '2026-08-12T00:00:00.000Z', revokedAt: null, agentProtocolVersion: null, capabilities: []};
    const createStoragePairingCode = vi.fn(async () => ({code: 'QRM-TRANSFER', purpose: 'TRANSFER' as const,
      expiresAt: '2026-08-13T01:00:00.000Z'}));
    const revokeStorageHost = vi.fn(async () => ({...host, status: 'REVOKED' as const}));
    const client = api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [host]),
      createStoragePairingCode, revokeStorageHost});
    const view = await render('OWNER', client, 'owner');
    expect(view.textContent).toContain('主席电脑 · 离线');
    await act(async () => {button('转移到其他电脑')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(createStoragePairingCode).toHaveBeenCalledWith(committeeId, 2, 'TRANSFER');
    await act(async () => {button('关闭配对码')?.click();});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {button('撤销主席电脑')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(revokeStorageHost).toHaveBeenCalledWith(committeeId, 'host', 2);
  });

  it('shows durable conflicts and sends the loaded conflict, lease, and file revisions', async () => {
    const host = {id: 'host', committeeId, deviceId: 'device', deviceLabel: '主席电脑', leaseGeneration: 7,
      status: 'ACTIVE' as const, revision: 1, lastSeenAt: '2026-08-13T00:00:00.000Z',
      pairedAt: '2026-08-13T00:00:00.000Z', revokedAt: null, agentProtocolVersion: 2,
      capabilities: ['SSE_WAKE', 'CACHE_REFILL'] as StorageHost['capabilities']};
    const conflict = {id: 'conflict', committeeId, hostId: 'host', fileEntryId: file.id, serverRevision: 3,
      localBaseRevision: 2, reasonCode: 'REVISION_CONFLICT' as const, status: 'PENDING' as const, revision: 1,
      change: {kind: 'UPSERT' as const, fileEntryId: file.id, baseRevision: 2, logicalName: '工作文件一',
        originalName: 'draft.txt', mediaType: 'text/plain', sizeBytes: 3, sha256: 'b'.repeat(64)},
      resolutionAction: null, resolutionLogicalName: null, resolutionLeaseGeneration: null,
      resolutionFileRevision: null, createdAt: '2026-08-13T00:00:00.000Z', resolvedAt: null};
    const resolveStorageAgentConflict = vi.fn(async () => ({...conflict, status: 'RESOLVED' as const,
      revision: 2, resolutionAction: 'ACCEPT_LOCAL' as const}));
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => []),
      listStorageHosts: vi.fn(async () => [host]), listStorageAgentConflicts: vi.fn(async () => [conflict]),
      resolveStorageAgentConflict}), 'chair');
    expect(view.textContent).toContain('文件已有新版本');
    await act(async () => {button('采用本地版本')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, 'conflict', {
      baseRevision: 1, leaseGeneration: 7, fileRevision: 3, action: 'ACCEPT_LOCAL'
    }, expect.any(String));
  });

  it('sends an explicit replacement name when accepting a local name conflict', async () => {
    const host = {id: 'host', committeeId, deviceId: 'device', deviceLabel: '主席电脑', leaseGeneration: 7,
      status: 'ACTIVE' as const, revision: 1, lastSeenAt: null,
      pairedAt: '2026-08-13T00:00:00.000Z', revokedAt: null, agentProtocolVersion: 2,
      capabilities: ['SSE_WAKE', 'CACHE_REFILL'] as StorageHost['capabilities']};
    const conflict = {id: 'name-conflict', committeeId, hostId: 'host', fileEntryId: file.id, serverRevision: 3,
      localBaseRevision: 2, reasonCode: 'NAME_CONFLICT' as const, status: 'PENDING' as const, revision: 1,
      change: {kind: 'RENAME' as const, fileEntryId: file.id, baseRevision: 2, logicalName: '重名文件.txt'},
      resolutionAction: null, resolutionLogicalName: null, resolutionLeaseGeneration: null,
      resolutionFileRevision: null, createdAt: '2026-08-13T00:00:00.000Z', resolvedAt: null};
    const resolveStorageAgentConflict = vi.fn(async () => ({...conflict, status: 'RESOLVED' as const,
      revision: 2, resolutionAction: 'ACCEPT_LOCAL' as const}));
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => []),
      listStorageHosts: vi.fn(async () => [host]), listStorageAgentConflicts: vi.fn(async () => [conflict]),
      resolveStorageAgentConflict}), 'chair');
    const name = view.querySelector('input[aria-label="新文件名称"]') as HTMLInputElement;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      ?.call(name, '改名文件.txt'); name.dispatchEvent(new Event('input', {bubbles: true}));});
    await act(async () => {button('采用本地版本')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, 'name-conflict', {
      baseRevision: 1, leaseGeneration: 7, fileRevision: 3, action: 'ACCEPT_LOCAL', logicalName: '改名文件.txt'
    }, expect.any(String));
  });

  it('cancels an in-flight upload through AbortSignal without clearing the selected file', async () => {
    const uploadFileContent = vi.fn((_id, _file, _key, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true});
    }));
    const client = api({listFiles: vi.fn(async () => []), createFileUpload: vi.fn(async () => ({id: 'upload',
      status: 'CREATED'})), uploadFileContent} as unknown as Partial<SelfHostedApi>);
    const view = await render('MEMBER', client, 'member');
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {configurable: true, value: [new File(['abc'], 'draft.txt')]});
    await act(async () => {input.dispatchEvent(new Event('change', {bubbles: true}));});
    await act(async () => {button('上传文件')?.click(); await new Promise(resolve => setTimeout(resolve, 20));});
    expect(button('取消上传')).toBeTruthy();
    await act(async () => {button('取消上传')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(view.textContent).toContain('已取消上传');
    expect(button('上传文件')).toBeTruthy();
  });

  it('shows migration states and only offers valid retry, confirm, and cancel commands', async () => {
    const migrations = [
      {id: 'failed', status: 'FAILED', revision: 2, completedItems: 1, totalItems: 2},
      {id: 'ready', status: 'READY_TO_CONFIRM', revision: 3, completedItems: 2, totalItems: 2},
      {id: 'copying', status: 'COPYING', revision: 1, completedItems: 0, totalItems: 2},
      {id: 'completed', status: 'COMPLETED', revision: 4, completedItems: 2, totalItems: 2},
      {id: 'cancelled', status: 'CANCELLED', revision: 2, completedItems: 0, totalItems: 2}
    ] as StorageMigration[];
    const client = api({listStorageBindings: vi.fn(async () => [{id: 'binding', committeeId,
      providerType: 'SERVER_VOLUME', providerConfigId: null, storageHostId: null, status: 'ACTIVE', revision: 1,
      createdAt: '2026-08-13T00:00:00.000Z'}] as Awaited<ReturnType<SelfHostedApi['listStorageBindings']>>),
      listStorageMigrations: vi.fn(async () => migrations)});
    const view = await render('OWNER', client, 'owner');
    expect(view.textContent).toContain('迁移失败'); expect(view.textContent).toContain('等待确认');
    expect(view.textContent).toContain('正在复制'); expect(view.textContent).toContain('迁移完成');
    expect(view.textContent).toContain('已取消'); expect(button('重试迁移')).toBeTruthy();
    expect(button('确认切换')).toBeTruthy();
  });

  it('groups the review queue separately and sorts both reviewed filters by review time', async () => {
    const entries: FileEntry[] = [
      {...file, id: 'published-old', logicalName: 'Earlier approval', status: 'PUBLISHED', submittedAt: '2026-09-20T00:00:00Z'},
      {...file, id: 'rejected-old', logicalName: 'Earlier rejection', status: 'REJECTED', submittedAt: '2026-09-20T00:00:00Z', rejectionReason: 'Change the format'},
      {...file, id: 'pending', logicalName: 'Pending source', status: 'PENDING_REVIEW'},
      {...file, id: 'published-new', logicalName: 'Later approval', status: 'PUBLISHED', submittedAt: '2026-09-01T00:00:00Z'},
      {...file, id: 'rejected-new', logicalName: 'Later rejection', status: 'REJECTED', submittedAt: '2026-09-01T00:00:00Z'}
    ];
    const reviewFiles = entries.map(entry => ({...entry, originalName: 'draft.svg', sizeBytes: 3,
      submissionSource: 'CHAIR', submitterDisplayName: null, fileType: 'WORKING_PAPER', publishedAt: '',
      reviewedAt: entry.id.endsWith('new') ? '2026-09-22T00:00:00Z' : '2026-09-21T00:00:00Z'})) as import('@quorum/contracts').DelegateReviewFile[];
    const client = api({listFiles: vi.fn(async () => entries)});
    const view = await render('CHAIR', client, 'chair');
    await act(async () => root!.render(<MemoryRouter><FilesPanel snapshot={snapshot('CHAIR')} api={client}
      section="overview" reviewFiles={reviewFiles} reviewPanel={<div className="test-review-queue">Review queue</div>} /></MemoryRouter>));
    const names = () => [...view.querySelectorAll('.self-hosted-file-heading > .header')].map(node => node.textContent);
    expect(names()).toEqual(['Later approval', 'Earlier approval']);
    expect(view.querySelector('.test-review-queue')).not.toBeNull();
    expect(view.querySelectorAll('.delegate-file-review-divider')).toHaveLength(1);
    expect(view.textContent).not.toContain('Pending source');
    expect(view.querySelector('.self-hosted-file-toolbar h3')).toBeNull();
    await act(async () => view.querySelector<HTMLElement>('[aria-label="文件状态"]')!.click());
    const options = [...view.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map(option => option.textContent)).toEqual(['待审核与已发布', '已驳回']);
    await act(async () => options.find(option => option.textContent === '已驳回')!.click());
    expect(names()).toEqual(['Later rejection', 'Earlier rejection']);
    expect(view.querySelector('.test-review-queue')).toBeNull();
    expect(view.querySelector('.delegate-file-review-divider')).toBeNull();
    expect(view.querySelector('.self-hosted-file-rejection')?.textContent).toContain('Change the format');
    expect(view.querySelector('.self-hosted-file-rejection')?.classList.contains('negative')).toBe(false);
  });

  it('routes pending files to review and deletes with the loaded revision', async () => {
    let current: FileEntry[] = [{...file, status: 'PENDING_REVIEW', revision: 2}];
    const publishFile = vi.fn(async () => {current = [{...file, status: 'PUBLISHED', revision: 3}]; return current[0];});
    const deleteFile = vi.fn(async () => {current = []; return {id: 'tombstone', fileEntryId: file.id};});
    const client = api({listFiles: vi.fn(async () => current), publishFile, deleteFile});
    const view = await render('CHAIR', client, 'chair');
    expect(view.querySelector('a[href$="/posts/review"]')?.textContent).toBe('文件审核');
    expect(publishFile).not.toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {button('永久删除')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(deleteFile).toHaveBeenCalledWith(file.id, 2);
    expect(view.textContent).not.toContain('工作文件一');
  });
});
