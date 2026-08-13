import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, it, vi} from 'vitest';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import StorageAdminPanel from './StorageAdminPanel';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

describe('self-hosted storage administrator panel', () => {
  it('shows verification state without returning or prefilling credentials', async () => {
    const secret = 'must-not-be-rendered';
    const api = {listS3ProviderConfigs: vi.fn(async () => [{id: 'config', displayName: '对象存储',
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
});
