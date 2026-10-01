import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import SelfHostedIdentity from './SelfHostedIdentity';
import {IdentityApiError, type SelfHostedIdentityClient, type SelfHostedUser} from '../services/self-hosted-identity';
import {selfHostedApi, SelfHostedApiError} from '../services/self-hosted-api';

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
  vi.unstubAllGlobals();
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
    getDefaultCommitteeBehavior: vi.fn(async () => ({creatorIsChair: true, operationMode: 'CHAIR_OPERATED' as const, revision: 1})),
    updateDefaultCommitteeBehavior: vi.fn(async input => input),
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

async function renderClient(identityClient: SelfHostedIdentityClient, path = '/'): Promise<string> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MemoryRouter initialEntries={[path]}><SelfHostedIdentity client={identityClient} /></MemoryRouter>);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return container.textContent ?? '';
}

describe('self-hosted identity screens', () => {
  it.each([
    [0, 'NETWORK_ERROR', 'Connection failed'],
    [500, 'HTTP_ERROR', 'Server error'],
    [502, 'HTTP_ERROR', 'Service unavailable'],
    [503, 'SERVICE_NOT_READY', 'Service unavailable'],
    [504, 'HTTP_ERROR', 'Request timed out'],
    [403, 'FORBIDDEN', 'Access denied'],
    [429, 'RATE_LIMITED', 'Too many requests'],
    [200, 'INVALID_RESPONSE', 'Invalid server response']
  ])('distinguishes startup error %s', async (status, code, title) => {
    const text = await renderClient(client({bootstrapStatus: vi.fn(async () => {
      throw new IdentityApiError(status as number, code as string, 'The server returned an invalid response. Try again later.');
    })}));
    expect(text).toContain(title);
    expect(text).not.toContain('Authentication error');
    expect(container?.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('retries initialization and returns to login after recovery', async () => {
    const bootstrapStatus = vi.fn().mockRejectedValueOnce(new IdentityApiError(500, 'HTTP_ERROR', 'raw error'))
      .mockResolvedValue(true);
    const identityClient = client({bootstrapStatus, me: vi.fn(async () => {
      throw new IdentityApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    })});
    await renderClient(identityClient);
    await act(async () => {
      [...container!.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click();
    });
    expect(bootstrapStatus).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain('Login');
    expect(container!.textContent).not.toContain('Server error');
  });
  it('explains an unsupported identity endpoint without suggesting a login or retry', async () => {
    const identityClient = client({bootstrapStatus: vi.fn().mockRejectedValue(
      new IdentityApiError(404, 'NOT_FOUND', 'Private server diagnostic'))});
    const text = await renderClient(identityClient);
    expect(text).toContain('Service unavailable');
    expect(text).toContain('deployed version and configuration');
    expect(text).not.toContain('Retry');
    expect(text).not.toContain('Private server diagnostic');
    expect(identityClient.me).not.toHaveBeenCalled();
  });
  it('offers login after an authentication or permission failure during startup', async () => {
    await renderClient(client({me: vi.fn().mockRejectedValue(new IdentityApiError(403, 'FORBIDDEN', 'Hidden'))}));
    expect(container?.textContent).not.toContain('Retry');
    const login = [...container!.querySelectorAll('a')].find(link => link.textContent === 'Login');
    expect(login).toBeTruthy();
    await act(async () => {login?.click();});
    expect(container?.querySelector('input[type="email"]')).toBeTruthy();
  });
  it.each([true, false])('offers home for an unknown top-level address (anonymous: %s)', async anonymous => {
    const identityClient = client(anonymous ? {me: vi.fn().mockRejectedValue(
      new IdentityApiError(401, 'AUTHENTICATION_REQUIRED', 'Login'))} : {});
    const text = await renderClient(identityClient, '/incorrect-address');
    expect(text).toContain('page address is invalid');
    expect(text).not.toContain('Retry');
    expect([...container!.querySelectorAll('a')].find(link => link.textContent === 'Return home')?.getAttribute('href'))
      .toBe('/committees');
    expect(container?.querySelector('input[type="email"]')).toBeNull();
  });
  it('keeps an authenticated login address as a home redirect', async () => {
    const text = await renderClient(client({}), '/login');
    expect(text).toContain('Account administration');
    expect(text).not.toContain('page address is invalid');
  });

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
    expect(text).not.toContain('Temporary password');
    expect(text).not.toContain('Account administration');
  });

  it('offers anonymous access from the login screen', async () => {
    const identityClient = client({me: vi.fn(async () => { throw new (await import('../services/self-hosted-identity')).IdentityApiError(
      401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); })});
    const text = await renderClient(identityClient);

    expect(text).toContain('Browse public committees');
    expect(container?.querySelector('a[href="/committees"]')).toBeTruthy();
  });
  it('uses the URL committee ID for anonymous deep links and returns home without retrying', async () => {
    const id = '10000000-0000-4000-8000-000000000002';
    const read = vi.spyOn(selfHostedApi, 'snapshot').mockRejectedValue(new SelfHostedApiError(404, 'NOT_FOUND', 'Hidden'));
    vi.spyOn(selfHostedApi, 'listCommittees').mockResolvedValue([]);
    const identityClient = client({me: vi.fn().mockRejectedValue(new IdentityApiError(401, 'AUTHENTICATION_REQUIRED', 'Login'))});
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => {root?.render(<MemoryRouter initialEntries={[`/committees/${id}/crises/missing`]}>
      <SelfHostedIdentity client={identityClient} />
    </MemoryRouter>);});
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(id);
    expect(container.textContent).toContain('you need to log in');
    expect(container.textContent).not.toContain('Retry');
    expect(container.querySelector('a[href="/login"]')).toBeTruthy();
    const home = [...container.querySelectorAll('a')].find(link => link.textContent === 'Return home');
    await act(async () => {home?.click();});
    expect(container.textContent).toContain('No public committees');
    expect(container.textContent).not.toContain('does not exist');
  });

  it('shows account administration only to the system administrator', async () => {
    const identityClient = client({});
    const text = await renderClient(identityClient);

    expect(text).toContain('Account administration');
    expect(text).not.toContain('Default behavior');
    expect(text).not.toContain('默认驳回类型');
    expect(identityClient.getDefaultCommitteeBehavior).not.toHaveBeenCalled();
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
