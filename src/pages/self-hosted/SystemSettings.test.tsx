import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import SelfHostedWorkspace from '../SelfHostedWorkspace';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {SelfHostedIdentityClient, SelfHostedUser} from '../../services/self-hosted-identity';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {setLanguage('zh-CN');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {act(() => root.unmount()); host.remove();});
const config = {publishedCacheMaxBytes: 1000, pendingReviewMaxBytes: 500, pendingReviewCommitteeMaxBytes: 250,
  storageMinFreeBytes: 100, storageMinFreePercent: 20, revision: 2,
  hardLimits: {publishedCacheMaxBytes: 2000, pendingReviewMaxBytes: 1000, pendingReviewCommitteeMaxBytes: 500,
    storageMinFreeBytes: 100, storageMinFreePercent: 20}};
const mbToBytes = (value: number) => Math.round(value * 1024 * 1024);
const operations = {database: {schemaCompatibility: 52}, storage: {state: 'normal', usageRatio: 0.4},
  accounts: {active: 2}, committees: {active: 1}, queues: {agentTasks: 3},
  retention: {lastStatus: 'FAILED', lastCompletedAt: '2026-09-12T00:00:00Z'}};
const user = {id: 'admin', displayName: 'Admin', isSystemAdmin: true} as SelfHostedUser;
function clients() {
  const api = {operationsStatus: vi.fn(async () => operations), storageCacheStatus: vi.fn(async () => ({config,
    capacity: {totalBytes: 4000, availableBytes: 2000, quorumBytes: 300, pendingReviewBytes: 100,
      publishedCacheBytes: 200, otherStagingBytes: 0},
    runtime: {hits: 1, misses: 0, fetching: 0, lastEvictedAt: null, lastEvictedBytes: 0}})),
  storageCacheFiles: vi.fn(async () => ({files: [], page: 1, pageSize: 25, total: 0})),
  updateStorageCacheConfig: vi.fn(async input => ({...input, revision: input.revision + 1})),
  getDefaultFileRejectionTypes: vi.fn(async () => ({revision: 1, rejectionTypes: [
    {id: 'format', label: {'zh-CN': '格式'}, message: {'zh-CN': '请修改'}, custom: false}]})),
  listS3ProviderConfigs: vi.fn(async () => []), listCommittees: vi.fn(async () => []),
  listCountryTemplates: vi.fn(async () => []), listCommitteeTemplates: vi.fn(async () => [])};
  const client = {getDefaultCommitteeBehavior: vi.fn(async () => ({creatorIsChair: true,
    operationMode: 'CHAIR_OPERATED', revision: 1})), updateDefaultCommitteeBehavior: vi.fn(async value => value)};
  return {api, client};
}
async function render(path: string, deps = clients(), admin = true) {
  await act(async () => {root.render(<MemoryRouter initialEntries={[path]}>
    <SelfHostedWorkspace user={{...user, isSystemAdmin: admin}} logout={vi.fn()}
      api={deps.api as unknown as SelfHostedApi} identityClient={deps.client as unknown as SelfHostedIdentityClient} />
  </MemoryRouter>);});
  return deps;
}
async function fill(selector: string, value: string) {
  const input = host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

describe('system settings navigation and extracted settings', () => {
  it.each(['/system-settings', '/operations', '/system-settings/operations'])('opens the status tab at %s', async path => {
    const {api, client} = await render(path);
    expect(host.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe('/system-settings/operations');
    expect(host.textContent).toContain('执行失败');
    expect(host.querySelector('form')).toBeNull();
    expect(api.listS3ProviderConfigs).not.toHaveBeenCalled();
    expect(client.getDefaultCommitteeBehavior).not.toHaveBeenCalled();
  });
  it.each(['/storage', '/system-settings/storage'])('opens storage configuration at %s', async path => {
    const {api} = await render(path);
    expect(host.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe('/system-settings/storage');
    expect(host.textContent).toContain('新增存储配置');
    expect(api.operationsStatus).not.toHaveBeenCalled();
  });
  it('groups committee defaults and uses the supplied identity client when saving', async () => {
    const {api, client} = await render('/system-settings/defaults');
    expect(host.textContent).toContain('默认行为');
    expect(host.textContent).toContain('默认驳回类型');
    expect(api.getDefaultFileRejectionTypes).toHaveBeenCalledOnce();
    await act(async () => {host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    expect(client.updateDefaultCommitteeBehavior).toHaveBeenCalledWith({creatorIsChair: true,
      operationMode: 'CHAIR_OPERATED', revision: 1});
    expect(api.operationsStatus).not.toHaveBeenCalled();
  });
  it('keeps cache edits after a failed save and uses the returned revision on the next save', async () => {
    const deps = clients();
    deps.api.updateStorageCacheConfig.mockRejectedValueOnce(new Error('保存失败'));
    const {api} = await render('/system-settings/cache', deps);
    expect(api.storageCacheFiles).not.toHaveBeenCalled();
    await fill('#cache-publishedCacheMaxBytes', '900');
    const submit = async () => act(async () => {host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    await submit();
    expect(host.textContent).toContain('请求失败，请稍后重试。');
    expect((host.querySelector('#cache-publishedCacheMaxBytes') as HTMLInputElement).value).toBe('900');
    expect(api.updateStorageCacheConfig).toHaveBeenLastCalledWith({...config, publishedCacheMaxBytes: mbToBytes(900)});
    await submit();
    expect(host.textContent).toContain('已保存');
    await fill('#cache-publishedCacheMaxBytes', '800');
    await submit();
    expect(api.updateStorageCacheConfig).toHaveBeenLastCalledWith({...config, publishedCacheMaxBytes: mbToBytes(800), revision: 3});
  });
  it.each(['/system-settings/interface', '/system-settings/operations', '/system-settings/defaults', '/system-settings/cache', '/system-settings/storage'])
  ('does not load administrator settings for a regular account at %s', async path => {
    const {api, client} = await render(path, clients(), false);
    expect(host.querySelector('.self-hosted-system-settings')).toBeNull();
    expect(api.operationsStatus).not.toHaveBeenCalled();
    expect(api.storageCacheStatus).not.toHaveBeenCalled();
    expect(api.getDefaultFileRejectionTypes).not.toHaveBeenCalled();
    expect(api.listS3ProviderConfigs).not.toHaveBeenCalled();
    expect(client.getDefaultCommitteeBehavior).not.toHaveBeenCalled();
  });
});
