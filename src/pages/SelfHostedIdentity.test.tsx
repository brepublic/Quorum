import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import SelfHostedIdentity from './SelfHostedIdentity';
import type {SelfHostedIdentityClient, SelfHostedUser} from '../services/self-hosted-identity';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const admin: SelfHostedUser = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  displayName: 'Admin',
  status: 'ACTIVE',
  isSystemAdmin: true,
  sessionVersion: 1,
  mustChangePassword: false,
  createdAt: '2026-08-12T00:00:00.000Z',
  disabledAt: null
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

function client(overrides: Partial<SelfHostedIdentityClient>): SelfHostedIdentityClient {
  return {
    bootstrapStatus: vi.fn(async () => true),
    bootstrap: vi.fn(async () => admin),
    me: vi.fn(async () => admin),
    login: vi.fn(async () => admin),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => ({...admin, mustChangePassword: false})),
    elevate: vi.fn(async () => admin),
    listUsers: vi.fn(async () => [admin]),
    createUser: vi.fn(async () => ({user: admin, temporaryPassword: 'temporary'})),
    resetPassword: vi.fn(async () => ({user: admin, temporaryPassword: 'temporary'})),
    disableUser: vi.fn(async () => undefined),
    revokeSessions: vi.fn(async () => undefined),
    anonymizeUser: vi.fn(async () => ({
      user: {...admin, email: '', displayName: '匿名账号', status: 'ANONYMIZED' as const},
      replacementUserId: admin.id,
      transferred: {committees: 0, countryTemplates: 0, committeeTemplates: 0, rulePackages: 0}
    })),
    ...overrides
  };
}

async function renderClient(identityClient: SelfHostedIdentityClient): Promise<string> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MemoryRouter initialEntries={['/']}><SelfHostedIdentity client={identityClient} /></MemoryRouter>);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return container.textContent ?? '';
}

describe('self-hosted identity screens', () => {
  it('shows bootstrap only when the server reports an uninitialized instance', async () => {
    const identityClient = client({bootstrapStatus: vi.fn(async () => false)});
    const text = await renderClient(identityClient);

    expect(text).toContain('Initialize administrator');
    expect(text).toContain('Bootstrap secret');
    expect(identityClient.me).not.toHaveBeenCalled();
  });

  it('forces a temporary-password account into the password-change screen', async () => {
    const identityClient = client({me: vi.fn(async () => ({...admin, isSystemAdmin: false, mustChangePassword: true}))});
    const text = await renderClient(identityClient);

    expect(text).toContain('Change temporary password');
    expect(text).not.toContain('Account administration');
  });

  it('shows account administration only to the system administrator', async () => {
    const text = await renderClient(client({}));

    expect(text).toContain('Account administration');
    expect(text).toContain('Disable account');
    expect(text).toContain('Revoke sessions');
  });

  it('only offers irreversible anonymization for a disabled account with an active recipient', async () => {
    const disabled = {...admin, id: '20000000-0000-4000-8000-000000000001', email: 'old@example.com',
      displayName: 'Old', status: 'DISABLED' as const, isSystemAdmin: false};
    const anonymizeUser = vi.fn(async () => ({
      user: {...disabled, email: '', displayName: '匿名账号', status: 'ANONYMIZED' as const},
      replacementUserId: admin.id,
      transferred: {committees: 1, countryTemplates: 1, committeeTemplates: 1, rulePackages: 1}
    }));
    const identityClient = client({listUsers: vi.fn(async () => [admin, disabled]), anonymizeUser});
    await renderClient(identityClient);
    vi.spyOn(window, 'prompt').mockReturnValueOnce(admin.email).mockReturnValueOnce(disabled.email);
    const button = [...container!.querySelectorAll('button')].find(item =>
      item.textContent?.includes('Anonymize account') && !item.disabled)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.prompt).toHaveBeenNthCalledWith(2,
      'This cannot be undone. Enter “old@example.com” to anonymize this account:');
    expect(anonymizeUser).toHaveBeenCalledWith(disabled.id, admin.id, disabled.email);
  });
});
