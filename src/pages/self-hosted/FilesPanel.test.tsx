import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, FileEntry, StorageHost, StorageMigration,StorageBinding} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {SelfHostedApiError} from '../../services/self-hosted-api';
import {MemoryRouter} from 'react-router-dom';
import type {ChairAgentRelease, DevelopmentChairAgentRelease} from '../../components/ChairAgentDownload';
import {openChairAgent, downloadChairConfiguration} from '../../services/agent-pairing';
vi.mock('../../services/agent-pairing', () => ({openChairAgent: vi.fn(), downloadChairConfiguration: vi.fn()}));
const agentDownloads = vi.hoisted(() => ({release: undefined as ChairAgentRelease | DevelopmentChairAgentRelease | null | undefined}));
vi.mock('../../components/ChairAgentDownload', async importOriginal => {
  const actual = await importOriginal<typeof import('../../components/ChairAgentDownload')>();
  // Render the real download menu with controlled release metadata in regression cases.
  return {...actual, ChairAgentDownload: () => <actual.ChairAgentDownload release={agentDownloads.release} />};
});
import FilesPanel, {storageErrorText} from './FilesPanel';

beforeEach(() => {agentDownloads.release = undefined; setLanguage('zh-CN'); vi.spyOn(window, 'confirm').mockReturnValue(true);});

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const committeeId = '20000000-0000-4000-8000-000000000001';
const agentRelease: ChairAgentRelease = {schemaVersion: 1, serverVersion: 'v1.2.2-rc3', agentVersion: '0.1.0',
  commit: 'a'.repeat(40), releaseUrl: 'https://github.com/brepublic/Quorum/releases/tag/v1.2.2-rc3',
  platforms: {
    windows: {file: 'Agent-Setup.exe', url: '/downloads/chair-agent/v1.2.2-rc3/Agent-Setup.exe', size: 42, sha256: 'b'.repeat(64)},
    linux: {file: 'Agent.AppImage', url: '/downloads/chair-agent/v1.2.2-rc3/Agent.AppImage', size: 43, sha256: 'c'.repeat(64)}
  }};
const pairingConfiguration = {schemaVersion: 1 as const, kind: 'quorum-agent-pairing' as const,
  serverUrl: 'https://quorum.example.com', committeeId, committeeName: '安理会',
  pairingCode: 'QRM-ABCD-EFGH', purpose: 'INITIAL' as const, expiresAt: '2099-08-13T01:00:00.000Z'};
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
  motionSettings: {groupMotionTypes: true, showMotionsOnDemand: true, delegateMotionProposalsEnabled: false, delegateMotionVotingEnabled: false},
  layoutSettings: {moveQueueUp: false, timersInSeparateColumns: false},
  points: [], notes: [], textPosts: [], activeRules: {versionId: 'rules', activePhaseId: null, phases: [],
    attendanceResponses: [], pointTypes: [], motionTypes: [], speakerLists: [], ballots: {delegateMayChangeVote: false,
      chairMayCorrectVote: true, anonymousStrawpoll: false, mustCollectAllVotesWhenVetoSeatEligible: true},
    documents: {amendmentsPublicByDefault: false}}, sync: {committeeEventSequence: 1}};
}

function api(overrides: Partial<SelfHostedApi> = {}): SelfHostedApi {
  return {storagePolicy: async () => ({disabled: false, submissionBlocked: false, revision: 1}), listFiles: vi.fn(async () => [file]), fileDownloadUrl: vi.fn(id => `/api/v1/files/${id}/download`),
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
async function confirmConflict() {
  await act(async () => {document.querySelector<HTMLButtonElement>('.ui.modal .actions .negative.button, .ui.modal .actions .primary.button')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));});
}

afterEach(() => {if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined;
  vi.restoreAllMocks(); window.history.replaceState(null, '', window.location.pathname);});

describe('self-hosted stage 6 file panel', () => {
  it('serializes overlapping refreshes and reads again for changes received in flight', async () => {
    let finish!: (files: FileEntry[]) => void;
    const listFiles = vi.fn().mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}))
      .mockResolvedValue([{...file, logicalName: 'Latest file'}]);
    const client = api({listFiles});
    await render('CHAIR', client);
    for (let i = 0; i < 3; i++) await act(async () => root?.render(<MemoryRouter>
      <FilesPanel snapshot={{...snapshot('CHAIR'), sync: {committeeEventSequence: i + 2}}} api={client} />
    </MemoryRouter>));
    expect(listFiles).toHaveBeenCalledTimes(1);
    await act(async () => finish([file]));
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain('Latest file');
  });
  it('hides disabled volume targets and explains blocked submissions with a migration link', async () => {
    const client = api({storagePolicy: async () => ({disabled:true,submissionBlocked:true,revision:2})});
    const view = await render('CHAIR', client);
    expect(view.textContent).toContain('服务器卷已被管理员禁用');
    expect(view.querySelector('a[href$="/posts/storage"]')).not.toBeNull();
    expect(view.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
    expect(view.querySelector('.storage-target-row')?.textContent ?? '').not.toContain('服务器卷');
  });

  it('keeps server storage after pairing and only starts Chair migration on explicit submission',async()=>{
    const client=api({
      listStorageBindings:vi.fn(async():Promise<StorageBinding[]>=>[{id:'volume',committeeId,providerType:'SERVER_VOLUME',providerConfigId:null,storageHostId:null,status:'ACTIVE',revision:1,createdAt:new Date().toISOString()}]),
      listStorageHosts:vi.fn(async():Promise<StorageHost[]>=>[{id:'host',committeeId,deviceId:'device',deviceLabel:'Test Chair',status:'ACTIVE',leaseGeneration:1,revision:1,
        lastSeenAt:new Date().toISOString(),pairedAt:new Date().toISOString(),revokedAt:null,agentProtocolVersion:2,capabilities:['STORAGE_MIGRATION']}]),
      createStorageMigration:vi.fn(async()=>({} as StorageMigration))
    });
    const view=await render('CHAIR',client);
    expect(view.textContent).toContain('当前：服务器卷');
    expect(client.createStorageMigration).not.toHaveBeenCalled();
    expect(button('开始迁移')?.disabled).toBe(false);
    await act(async()=>{view.querySelector('.self-hosted-storage-panel form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    expect(client.createStorageMigration).not.toHaveBeenCalled();
    const dialog=document.querySelector('.storage-migration-confirm');
    expect(dialog?.textContent).toContain('Test Chair');
    expect(dialog?.textContent).toContain('清理服务器上的原文件');
    const dialogButton=(label:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('.storage-migration-confirm button')).find(item=>item.textContent===label)!;
    await act(async()=>dialogButton('取消').click());
    expect(client.createStorageMigration).not.toHaveBeenCalled();
    await act(async()=>{view.querySelector('.self-hosted-storage-panel form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    await act(async()=>dialogButton('确认并开始迁移').click());
    expect(client.createStorageMigration).toHaveBeenCalledTimes(1);
    expect(client.createStorageMigration).toHaveBeenCalledWith(committeeId,2,'CHAIR_AGENT');
  });

  it('shows real migration bytes, time estimate and blocks confirmation during the final device check',async()=>{
    const row:StorageMigration={id:'migration',committeeId,sourceBindingId:'volume',targetBindingId:'chair',status:'COPYING',
      manifestRevision:1,revision:1,totalItems:12,completedItems:4,failureCode:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      progress:{targetProviderType:'CHAIR_AGENT',targetDeviceLabel:'Test Chair',online:true,phase:'TRANSFERRING',totalBytes:280000000,
        completedBytes:96000000,currentName:'会议资料.pdf',currentBytes:18000000,currentTotalBytes:32000000,remainingSeconds:198}};
    const client=api({listStorageMigrations:vi.fn(async()=>[row])});
    let view=await render('CHAIR',client);expect(view.textContent).toContain('预计剩余时间');
    expect(view.textContent).toContain('约 3 分 20 秒');expect(view.textContent).toContain('会议资料.pdf');
    expect(button('开始迁移')).toBeUndefined();
    act(()=>root?.unmount());view.remove();root=undefined;container=undefined;
    row.status='READY_TO_CONFIRM';row.progress!.phase='CONFIRMING';
    view=await render('CHAIR',client);expect(view.textContent).toContain('正在复核并切换');expect(button('确认切换')).toBeUndefined();
  });

  it.each(['storage','all'] as const)('refreshes idle host heartbeats and detects disconnect and recovery in %s',async(section)=>{
    vi.useFakeTimers();
    try {
      let online=true;let stoppedAt=Date.now();
      const listStorageHosts=vi.fn(async():Promise<StorageHost[]>=>[{id:'host',committeeId,deviceId:'device',deviceLabel:'Test Chair',status:'ACTIVE',leaseGeneration:1,revision:1,
        lastSeenAt:new Date(online?Date.now():stoppedAt).toISOString(),pairedAt:new Date().toISOString(),revokedAt:null,
        agentProtocolVersion:2,capabilities:['STORAGE_MIGRATION']}]);
      const client=api({listStorageHosts,listStorageBindings:vi.fn(async():Promise<StorageBinding[]>=>[
        {id:'volume',committeeId,providerType:'SERVER_VOLUME',providerConfigId:null,storageHostId:null,status:'ACTIVE',revision:1,createdAt:new Date().toISOString()}])});
      container=document.createElement('div');document.body.append(container);root=createRoot(container);
      await act(async()=>root?.render(<MemoryRouter><FilesPanel snapshot={snapshot('CHAIR')} api={client} section={section} /></MemoryRouter>));
      expect(button('开始迁移')?.disabled).toBe(false);
      await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
      expect(listStorageHosts).toHaveBeenCalledTimes(5);
      expect(client.listStorageMigrations).toHaveBeenCalledTimes(1);
      expect(button('开始迁移')?.disabled).toBe(false);
      online=false;stoppedAt=Date.now();
      await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
      expect(button('开始迁移')?.disabled).toBe(true);
      expect(container.textContent).toContain('主席电脑离线');
      online=true;
      await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
      expect(button('开始迁移')?.disabled).toBe(false);
      const reads=listStorageHosts.mock.calls.length;
      act(()=>root?.unmount());root=undefined;
      await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
      expect(listStorageHosts).toHaveBeenCalledTimes(reads);
    } finally {if(root){act(()=>root?.unmount());root=undefined;}vi.useRealTimers();}
  });

  it.each([['attachments',true],['storage',false]] as const)('does not poll idle hosts outside storage or before pairing (%s, %s)',async(section,paired)=>{
    vi.useFakeTimers();
    try {
      const listStorageHosts=vi.fn(async():Promise<StorageHost[]>=>paired?[{id:'host',committeeId,deviceId:'device',deviceLabel:'Test Chair',status:'ACTIVE',leaseGeneration:1,revision:1,
        lastSeenAt:new Date().toISOString(),pairedAt:new Date().toISOString(),revokedAt:null,agentProtocolVersion:2,capabilities:['STORAGE_MIGRATION']}]:[]);
      const client=api({listStorageHosts});
      container=document.createElement('div');document.body.append(container);root=createRoot(container);
      await act(async()=>root?.render(<MemoryRouter><FilesPanel snapshot={snapshot('CHAIR')} api={client} section={section} /></MemoryRouter>));
      await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
      expect(listStorageHosts).toHaveBeenCalledTimes(1);
    } finally {if(root){act(()=>root?.unmount());root=undefined;}vi.useRealTimers();}
  });

  it.each([false,true])('requires both a recent heartbeat and migration capability before starting (offline: %s)',async(offline)=>{
    const client=api({listStorageBindings:vi.fn(async():Promise<StorageBinding[]>=>[{id:'volume',committeeId,providerType:'SERVER_VOLUME',providerConfigId:null,storageHostId:null,status:'ACTIVE',revision:1,createdAt:new Date().toISOString()}]),
      listStorageHosts:vi.fn(async():Promise<StorageHost[]>=>[{id:'host',committeeId,deviceId:'device',deviceLabel:'Test Chair',status:'ACTIVE',leaseGeneration:1,revision:1,
        lastSeenAt:new Date(Date.now()-(offline?60000:0)).toISOString(),pairedAt:new Date().toISOString(),revokedAt:null,agentProtocolVersion:2,
        capabilities:offline?['STORAGE_MIGRATION']:[]}])});
    await render('CHAIR',client);expect(button('开始迁移')?.disabled).toBe(true);
  });
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
      expiresAt: '2099-08-13T01:00:00.000Z', configuration: pairingConfiguration}));
    const manager = await render('CHAIR', api({listFiles: vi.fn(async () => []), createStoragePairingCode}), 'chair');
    await act(async () => {button('配对主席电脑')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(createStoragePairingCode).toHaveBeenCalledWith(committeeId, 2, 'INITIAL');
    expect(manager.textContent).toContain('QRM-ABCD-EFGH');
    expect(openChairAgent).toHaveBeenCalledWith(pairingConfiguration);
    await act(async () => {button('下载配对文件')?.click();});
    expect(downloadChairConfiguration).toHaveBeenCalledWith(pairingConfiguration);
    expect(createStoragePairingCode).toHaveBeenCalledTimes(1);
    act(() => root?.unmount()); manager.remove(); root = undefined; container = undefined;

    const member = await render('MEMBER', api({createStoragePairingCode}), 'member');
    expect(member.textContent).not.toContain('配对主席电脑');
    expect(createStoragePairingCode).toHaveBeenCalledTimes(1);
  });

  it('reports an unfinished launch without claiming that the Agent paired', async () => {
    const createStoragePairingCode = vi.fn(async () => ({code:'QRM-ABCD-EFGH',purpose:'INITIAL' as const,
      expiresAt:'2099-08-13T01:00:00.000Z',configuration:pairingConfiguration}));
    const view = await render('CHAIR', api({listFiles:vi.fn(async()=>[]),createStoragePairingCode}), 'chair');
    vi.useFakeTimers();
    try {
      await act(async () => {button('配对主席电脑')?.click();});
      expect(view.textContent).toContain('等待主席 Agent 配对');
      expect(view.textContent).not.toContain('配对完成');
      await act(async () => {await vi.advanceTimersByTimeAsync(8000);});
      expect(view.textContent).toContain('若 Agent 未打开，请下载配对文件');
      expect(view.textContent).not.toContain('配对完成');
    } finally {vi.useRealTimers();}
  });

  it('uses the loaded committee revision when transferring or revoking the active host', async () => {
    const host = {id: 'host', committeeId, deviceId: 'device', deviceLabel: '主席电脑', leaseGeneration: 1,
      status: 'DEGRADED' as const, revision: 2, lastSeenAt: '2026-08-13T00:00:00.000Z',
      pairedAt: '2026-08-12T00:00:00.000Z', revokedAt: null, agentProtocolVersion: null, capabilities: []};
    const createStoragePairingCode = vi.fn(async () => ({code: 'QRM-TRANSFER', purpose: 'TRANSFER' as const,
      expiresAt: '2099-08-13T01:00:00.000Z', configuration: pairingConfiguration}));
    const revokeStorageHost = vi.fn(async () => ({...host, status: 'REVOKED' as const}));
    const client = api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [host]),
      createStoragePairingCode, revokeStorageHost});
    const view = await render('OWNER', client, 'owner');
    expect(view.textContent).toContain('主席电脑 · 离线');
    await act(async () => {button('转移到其他电脑')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(createStoragePairingCode).toHaveBeenCalledWith(committeeId, 2, 'TRANSFER');
    await act(async () => {button('关闭')?.click();});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {button('撤销主席电脑')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(revokeStorageHost).toHaveBeenCalledWith(committeeId, 'host', 2);
  });

  it.each([false, true])('shows durable conflicts and follows the Agent conflict link only when requested (%s)', async followLink => {
    window.history.replaceState(null, '', followLink ? '#sync-conflicts' : window.location.pathname);
    const scroll = vi.fn();
    const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: scroll});
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
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => [{...file, revision: 3}]),
      listStorageHosts: vi.fn(async () => [host]), listStorageAgentConflicts: vi.fn(async () => [conflict]),
      resolveStorageAgentConflict}), 'chair');
    expect(view.textContent).toContain('本地文件与服务器文件内容不同');
    const list = view.querySelector('#sync-conflicts');
    expect(list).not.toBeNull();
    expect(document.activeElement === list).toBe(followLink);
    expect(scroll.mock.calls.length).toBe(followLink ? 1 : 0);
    if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    await act(async () => {button('保留本地版本')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    await confirmConflict();
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
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => [{...file, revision: 3}]),
      listStorageHosts: vi.fn(async () => [host]), listStorageAgentConflicts: vi.fn(async () => [conflict]),
      resolveStorageAgentConflict}), 'chair');
    expect(view.querySelector('[data-conflict-id="name-conflict"] > .content > .header')?.textContent).toBe('重名文件.txt');
    const name = view.querySelector('input[aria-label="新文件名称"]') as HTMLInputElement;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      ?.call(name, '改名文件.txt'); name.dispatchEvent(new Event('input', {bubbles: true}));});
    await act(async () => {button('采用本地名称')?.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    await confirmConflict();
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, 'name-conflict', {
      baseRevision: 1, leaseGeneration: 7, fileRevision: 3, action: 'ACCEPT_LOCAL', logicalName: '改名文件.txt'
    }, expect.any(String));
  });

  function comparisonFixture(overrides: Partial<import('@quorum/contracts').StorageAgentConflict> = {}) {
    const host = {id: 'host', committeeId, deviceId: 'device', deviceLabel: '测试主席电脑', leaseGeneration: 7,
      status: 'ACTIVE' as const, revision: 1, lastSeenAt: null, pairedAt: '2026-08-13T00:00:00Z', revokedAt: null,
      agentProtocolVersion: 2, capabilities: ['SSE_WAKE', 'CACHE_REFILL'] as StorageHost['capabilities']};
    const conflict: import('@quorum/contracts').StorageAgentConflict = {id: 'comparison', committeeId, hostId: 'host',
      fileEntryId: file.id, serverRevision: 2, localBaseRevision: 2, reasonCode: 'REVISION_CONFLICT',
      status: 'PENDING', revision: 1, change: {kind: 'UPSERT', fileEntryId: file.id, baseRevision: 2,
        logicalName: '本地草案.txt', originalName: 'draft.txt', mediaType: 'text/plain', sizeBytes: 5, sha256: 'b'.repeat(64)},
      serverFile: {...file, revision: 4, mergedIntoFileEntryId: null}, resolutionAction: null,
      resolutionLogicalName: null, resolutionLeaseGeneration: null, resolutionFileRevision: null,
      createdAt: '2026-08-13T00:00:00Z', resolvedAt: null, ...overrides};
    return {host, conflict};
  }

  it('compares both sources, marks a recommendation and resolves against the current source revision', async () => {
    const {host, conflict} = comparisonFixture();
    if (conflict.change.kind === 'UPSERT') conflict.change.logicalName = 'content';
    const resolveStorageAgentConflict = vi.fn(async () => ({...conflict, status: 'RESOLVED' as const}));
    const view = await render('CHAIR', api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), resolveStorageAgentConflict}), 'chair');
    const card = view.querySelector('[data-conflict-id="comparison"]')!;
    expect(card.querySelector('.content > .header')?.textContent).toBe(file.logicalName);
    expect(card.querySelector('.conflict-records dd')?.textContent).toBe('2');
    expect(card.querySelector('.conflict-decision-summary')?.textContent).toContain('本地文件与服务器文件内容不同');
    expect(card.querySelector('.conflict-versions')?.textContent).not.toMatch(/修订|无法确定/);
    expect(card.querySelector('.conflict-fingerprints')?.hasAttribute('open')).toBe(false);
    expect(view.querySelector('.conflict-recommendation')?.textContent).toContain('保留两份');
    expect(resolveStorageAgentConflict).not.toHaveBeenCalled();
    await act(async () => {button('保留服务器版本')!.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    await confirmConflict();
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, conflict.id,
      expect.objectContaining({fileRevision: 4, leaseGeneration: 7, baseRevision: 1, action: 'KEEP_SERVER'}), expect.any(String));
  });

  it('lets the Chair cancel or explicitly keep either side of a published conflict', async () => {
    const {host, conflict} = comparisonFixture();
    conflict.serverFile = {...conflict.serverFile!, status: 'PUBLISHED', publishedAt: '2026-10-06T12:00:00Z'};
    const resolveStorageAgentConflict = vi.fn(async () => ({...conflict, status: 'RESOLVED' as const}));
    await render('CHAIR', api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), resolveStorageAgentConflict}), 'chair');
    await act(async () => button('保留本地版本')!.click());
    expect(document.querySelector('.ui.modal')?.textContent).toContain('此操作无法在界面中撤销');
    expect(document.querySelector('.ui.modal')?.textContent).toContain('服务器上的这份文件将被替换');
    expect(resolveStorageAgentConflict).not.toHaveBeenCalled();
    await act(async () => {document.querySelector<HTMLButtonElement>('.ui.modal .actions .button')!.click();});
    await act(async () => button('保留本地版本')!.click());
    await confirmConflict();
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, conflict.id,
      expect.objectContaining({action: 'ACCEPT_LOCAL', fileRevision: 4}), expect.any(String));
  });

  it('requires a fresh choice if the server version changes while confirmation is open', async () => {
    const {host, conflict} = comparisonFixture();
    let current = conflict;
    const resolveStorageAgentConflict = vi.fn();
    const client = api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [current]), resolveStorageAgentConflict});
    await render('CHAIR', client, 'chair');
    await act(async () => button('保留本地版本')!.click());
    current = {...conflict, serverFile: {...conflict.serverFile!, revision: 5}};
    await act(async () => {root!.render(<MemoryRouter><FilesPanel snapshot={snapshot('CHAIR')} api={client} currentUserId="chair" /></MemoryRouter>);});
    await confirmConflict();
    expect(resolveStorageAgentConflict).not.toHaveBeenCalled();
    expect(container?.textContent).toContain('状态已更新');
  });

  it('uses the local name for an unsubmitted new file conflict', async () => {
    const {host, conflict} = comparisonFixture({fileEntryId: null, serverFile: undefined, serverRevision: null});
    if (conflict.change.kind === 'UPSERT') conflict.change.fileEntryId = undefined;
    const view = await render('CHAIR', api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict])}), 'chair');
    expect(view.querySelector('[data-conflict-id="comparison"] > .content > .header')?.textContent).toBe('本地草案.txt');
  });

  it('protects currently formal files even when their conflict still has an ordinary revision reason', async () => {
    const {host, conflict} = comparisonFixture(); conflict.serverFile = {...conflict.serverFile!, status: 'PUBLISHED',
      publishedAt: '2026-10-06T12:00:00Z'};
    const view = await render('CHAIR', api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict])}), 'chair');
    expect(view.textContent).toContain('建议先保留已发布的服务器文件');
    expect(view.textContent).toContain('选择前，请下载服务器文件');
    expect(view.querySelector('.conflict-recommendation .icon')).toBeNull();
    expect(button('保留本地版本')?.disabled).toBe(false); expect(button('保留服务器版本')?.disabled).toBe(false);
    expect(button('另存为新文件')).toBeUndefined();
    expect(view.querySelector('.conflict-version-recommended')?.getAttribute('aria-label')).toBe('服务器版本');
  });

  it('allows a local deletion of an ordinary formal file and fences the decision with the current source revision', async () => {
    const {host, conflict} = comparisonFixture({localBaseRevision: 4,
      change: {kind: 'DELETE', fileEntryId: file.id, baseRevision: 4}});
    conflict.serverFile = {...conflict.serverFile!, status: 'PUBLISHED', publishedAt: '2026-10-06T12:00:00Z'};
    const resolveStorageAgentConflict = vi.fn(async () => ({...conflict, status: 'RESOLVED' as const}));
    const view = await render('CHAIR', api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), resolveStorageAgentConflict}), 'chair');
    const card = view.querySelector('[data-conflict-id="comparison"]')!;
    expect(card.querySelector('.content > .header')?.textContent).toBe(file.logicalName);
    expect(card.textContent).toContain('本地文件已删除');
    expect(card.textContent).not.toContain('正式文件的修改须在网页上传后审核');
    expect(view.querySelector('.conflict-version-recommended')?.getAttribute('aria-label')).toBe('本地版本');
    expect(button('另存为新文件')).toBeUndefined();
    expect(resolveStorageAgentConflict).not.toHaveBeenCalled();
    await act(async () => {button('删除服务器文件')!.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    await confirmConflict();
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, conflict.id,
      {baseRevision: 1, leaseGeneration: 7, fileRevision: 4, action: 'ACCEPT_LOCAL'}, expect.any(String));
  });

  it('prepares a server download, reports a cache failure and lets the user retry', async () => {
    const {host, conflict} = comparisonFixture();
    const prepareFileDownload = vi.fn().mockResolvedValueOnce({status: 'PREPARING', retryAfterSeconds: 0})
      .mockResolvedValue({status: 'READY'});
    const fileDownloadReadiness = vi.fn(async () => ({status: 'UNAVAILABLE' as const, code: 'STORAGE_AGENT_OFFLINE' as const}));
    const fileDownloadUrl = vi.fn(id => id === file.id ? '#server-download-ready' : '#other');
    const view = await render('CHAIR', api({listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), prepareFileDownload, fileDownloadReadiness, fileDownloadUrl}), 'chair');
    const download = () => [...view.querySelectorAll<HTMLAnchorElement>('[data-conflict-id="comparison"] a[download]')]
      .find(item => item.textContent?.includes('下载服务器版本'))!;
    await act(async () => {download().click(); await new Promise(resolve => setTimeout(resolve, 15));});
    expect(prepareFileDownload).toHaveBeenCalledWith(file.id); expect(fileDownloadReadiness).toHaveBeenCalledWith(file.id);
    expect(view.querySelector('.ui.message[role="alert"]')).not.toBeNull();
    await act(async () => {download().click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(prepareFileDownload).toHaveBeenCalledTimes(2); expect(window.location.hash).toBe('#server-download-ready');
    expect(view.querySelector('.ui.message[role="alert"]')).toBeNull();
  });

  it('downloads a merged formal target but keeps the original source revision for the decision', async () => {
    const {host, conflict} = comparisonFixture();
    conflict.serverFile = {...conflict.serverFile!, logicalName: '原始提交', mergedIntoFileEntryId: 'formal-target'};
    if (conflict.change.kind === 'UPSERT') conflict.change.logicalName = 'content';
    const getFile = vi.fn(async () => ({...file, id: 'formal-target', logicalName: '正式目标', revision: 99}));
    const prepareFileDownload = vi.fn(async () => ({status: 'READY' as const}));
    const resolveStorageAgentConflict = vi.fn(async () => ({...conflict, status: 'RESOLVED' as const}));
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), getFile, prepareFileDownload, resolveStorageAgentConflict,
      fileDownloadUrl: vi.fn(id => `#download-${id}`)}), 'chair');
    expect(getFile).toHaveBeenCalledWith(file.id);
    expect(view.querySelector('[data-conflict-id="comparison"] > .content > .header')?.textContent).toBe('原始提交');
    const link = [...view.querySelectorAll<HTMLAnchorElement>('[data-conflict-id="comparison"] a[download]')].find(item => item.textContent?.includes('下载服务器正式版本'))!;
    await act(async () => {link.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(prepareFileDownload).toHaveBeenCalledWith('formal-target');
    await act(async () => {button('保留服务器版本')!.click(); await new Promise(resolve => setTimeout(resolve, 0));});
    await confirmConflict();
    expect(resolveStorageAgentConflict).toHaveBeenCalledWith(committeeId, conflict.id,
      expect.objectContaining({fileRevision: 4}), expect.any(String));
    expect(button('保留本地版本')?.disabled).toBe(true);
  });

  it('automatically refreshes unavailable comparison details on a new workspace snapshot', async () => {
    const {host, conflict} = comparisonFixture({serverFile: undefined});
    let available = false; const getFile = vi.fn(async () => {
      if (!available) throw new SelfHostedApiError(503, 'SERVICE_NOT_READY', 'unavailable');
      return {...file, revision: 5};
    });
    const client = api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), getFile});
    const view = await render('CHAIR', client, 'chair');
    expect(view.textContent).toContain('可下载服务器文件');
    expect(button('保留本地版本')?.disabled).toBe(true); expect(button('另存为新文件')).toBeUndefined();
    expect(view.querySelector('[data-conflict-id="comparison"] a[download]')?.textContent).toContain('下载服务器版本');
    available = true;
    expect(button('刷新比较')).toBeUndefined();
    await act(async () => {root!.render(<MemoryRouter><FilesPanel snapshot={snapshot('CHAIR')} api={client} currentUserId="chair" /></MemoryRouter>);});
    expect(view.querySelectorAll('.conflict-records dd')[1]?.textContent).toBe('5'); expect(view.querySelector('.conflict-recommendation')?.textContent).toContain('保留两份');
    expect(view.querySelector('[data-conflict-id="comparison"] > .content > .header')?.textContent).toBe(file.logicalName);
  });

  it('recovers comparison details after a temporary failure without any user action or new event', async () => {
    const {host, conflict} = comparisonFixture({serverFile: undefined});
    const getFile = vi.fn().mockRejectedValueOnce(new SelfHostedApiError(503, 'SERVICE_NOT_READY', 'unavailable'))
      .mockResolvedValue({...file, revision: 5});
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict]), getFile}), 'chair');
    expect(button('保留本地版本')?.disabled).toBe(true);
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 5200));});
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(view.querySelectorAll('.conflict-records dd')[1]?.textContent).toBe('5');
    expect(button('保留本地版本')?.disabled).toBe(false);
  }, 10000);

  it('discards a pending old response and reads again after a newer workspace snapshot', async () => {
    let completeOld!: (files: FileEntry[]) => void;
    const listFiles = vi.fn().mockImplementationOnce(() => new Promise<FileEntry[]>(resolve => {completeOld = resolve;}))
      .mockResolvedValue([{...file, logicalName: '最新文件'}]);
    const client = api({listFiles});
    const view = await render('CHAIR', client, 'chair');
    await act(async () => {root!.render(<MemoryRouter><FilesPanel snapshot={snapshot('CHAIR')} api={client} currentUserId="chair" /></MemoryRouter>);});
    expect(listFiles).toHaveBeenCalledTimes(1);
    await act(async () => {completeOld([{...file, logicalName: '过期文件'}]);});
    expect(view.textContent).toContain('最新文件'); expect(view.textContent).not.toContain('过期文件');
  });

  it.each([
    {build: 'source', release: null},
    {build: 'release', release: agentRelease},
    {build: 'development Linux', release: {schemaVersion: 1, development: true, platforms: {linux: agentRelease.platforms.linux}} as DevelopmentChairAgentRelease},
    {build: 'development Windows', release: {schemaVersion: 1, development: true, platforms: {windows: agentRelease.platforms.windows}} as DevelopmentChairAgentRelease}
  ])('omits server download for a deleted source and offers save-as-new instead of acceptance ($build build)', async ({release}) => {
    agentDownloads.release = release;
    const {host, conflict} = comparisonFixture(); conflict.serverFile = {...conflict.serverFile!, status: 'DELETED'};
    const view = await render('CHAIR', api({listFiles: vi.fn(async () => []), listStorageHosts: vi.fn(async () => [host]),
      listStorageAgentConflicts: vi.fn(async () => [conflict])}), 'chair');
    const card = view.querySelector('[data-conflict-id="comparison"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('服务器文件已删除');
    expect(card!.querySelector('a[download]')).toBeNull();
    const installers = [...view.querySelectorAll<HTMLAnchorElement>('.chair-agent-download a[download]')];
    expect(installers.map(link => link.getAttribute('href'))).toEqual(release
      ? [release.platforms.windows?.url, release.platforms.linux?.url].filter(Boolean) : []);
    expect(button('保留本地版本')?.disabled).toBe(true); expect(view.querySelector('.conflict-recommendation')?.textContent).toContain('保留两份');
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
    await act(async () => {button('永久删除')?.click();});
    expect(deleteFile).not.toHaveBeenCalled();
    const modal = document.body.querySelector('.ui.modal')!;
    expect(modal.textContent).toContain(file.logicalName);
    await act(async () => {[...modal.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === '取消')!.click();});
    expect(deleteFile).not.toHaveBeenCalled();
    await act(async () => {button('永久删除')?.click();});
    await act(async () => {[...document.body.querySelectorAll<HTMLButtonElement>('.ui.modal button')].find(el => el.textContent === '永久删除')!.click();});
    expect(deleteFile).toHaveBeenCalledWith(file.id, 2);
    expect(view.textContent).not.toContain('工作文件一');
  });
});
