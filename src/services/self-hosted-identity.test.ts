import {afterEach, describe, expect, it, vi} from 'vitest';
import {selfHostedIdentityClient} from './self-hosted-identity';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('self-hosted identity client', () => {
  it('uses same-origin credentials and sends the CSRF token only on protected writes', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-quorum_csrf=test-csrf');
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {loggedOut: true}, meta: {requestId: 'request'}})}));
    vi.stubGlobal('fetch', fetchMock);

    await selfHostedIdentityClient.logout();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({'x-csrf-token': 'test-csrf'})
    }));
  });

  it('does not expose a self-registration method', () => {
    expect(selfHostedIdentityClient).not.toHaveProperty('register');
    expect(selfHostedIdentityClient).not.toHaveProperty('createRegistrationRequest');
  });

  it('does not resend the temporary password when setting the permanent password', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-quorum_csrf=test-csrf');
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {user: {id: 'user'}}, meta: {requestId: 'request'}})}));
    vi.stubGlobal('fetch', fetchMock);

    await selfHostedIdentityClient.changePassword('new-password-123');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/change-password', expect.objectContaining({
      body: JSON.stringify({newPassword: 'new-password-123'})
    }));
  });
});
