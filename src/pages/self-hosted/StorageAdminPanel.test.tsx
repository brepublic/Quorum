import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import StorageAdminPanel from './StorageAdminPanel';

beforeEach(() => setLanguage('zh-CN'));

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

describe('self-hosted storage administrator panel', () => {
  it('shows verification state without returning or prefilling credentials', async () => {
    const secret = 'must-not-be-rendered';
    const api = {serverVolumeFiles: async()=>({files:[],total:0,page:1,totalBytes:0,rootPath:"/storage/server-volume"}), serverVolumeCleanups:async()=>[], storagePolicy: async () => ({disabled: false, submissionBlocked: false, revision: 1}), serverVolumePolicy: async () => ({disabled: false, revision: 1}), listS3ProviderConfigs: vi.fn(async () => [{id: 'config', displayName: '对象存储',
      endpoint: 'https://s3.example.com', region: 'test-1', bucket: 'quorum', prefix: 'files',
      forcePathStyle: true, allowPrivateNetwork: false, status: 'ACTIVE', credentialKeyVersion: 1,
      verifiedAt: null, revision: 1, createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'}])} as unknown as SelfHostedApi;
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => {root.render(<StorageAdminPanel api={api} />); await new Promise(resolve => setTimeout(resolve, 0));});
    expect(container.textContent).toContain('对象存储'); expect(container.textContent).toContain('未验证');
    expect(container.textContent).not.toContain(secret);
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    act(() => root.unmount()); container.remove();
  });
  it('keeps an unfinished configuration while verifying another one', async () => {
    const verifyS3ProviderConfig=vi.fn(async()=>undefined);
    const api={serverVolumeFiles:async()=>({files:[],total:0,page:1,totalBytes:0,rootPath:'/storage'}),serverVolumeCleanups:async()=>[],
      serverVolumePolicy:async()=>({disabled:false,revision:1}),verifyS3ProviderConfig,listS3ProviderConfigs:async()=>[{id:'config',displayName:'已有配置',endpoint:'https://s3.example.com',region:'test',bucket:'files',prefix:'',status:'ACTIVE',revision:1}]} as unknown as SelfHostedApi;
    const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
    try {
      await act(async()=>root.render(<StorageAdminPanel api={api} />));
      const name=container.querySelector<HTMLInputElement>('form input')!;
      await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(name,'尚未完成的配置');name.dispatchEvent(new Event('input',{bubbles:true}));});
      await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('验证配置'))!.click());
      expect(verifyS3ProviderConfig).toHaveBeenCalledWith('config');expect(name.value).toBe('尚未完成的配置');
    } finally {act(()=>root.unmount());container.remove();}
  });

});
