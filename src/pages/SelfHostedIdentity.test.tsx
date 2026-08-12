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
});
