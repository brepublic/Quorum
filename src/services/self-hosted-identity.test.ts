import {afterEach, describe, expect, it, vi} from 'vitest';
import {selfHostedIdentityClient} from './self-hosted-identity';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('self-hosted identity client', () => {
  it('classifies network failure without exposing fetch internals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(selfHostedIdentityClient.bootstrapStatus()).rejects.toMatchObject({status: 0, code: 'NETWORK_ERROR'});
  });

  it.each([401, 403, 404, 429, 500, 502, 503, 504])('preserves HTTP %s for empty or non-JSON responses', async status => {
    for (const body of ['', '<html>Proxy error</html>']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {status})));
      await expect(selfHostedIdentityClient.bootstrapStatus()).rejects.toMatchObject({status, code: 'HTTP_ERROR'});
    }
  });

  it.each(['', 'null', '[]', '{}', '{"error":null}', '{"error":{"code":123}}'])('rejects malformed success: %s', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {status: 200})));
    await expect(selfHostedIdentityClient.bootstrapStatus()).rejects.toMatchObject({status: 200, code: 'INVALID_RESPONSE'});
  });

  it('preserves structured backend errors and request IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({error: {
      code: 'AUTHENTICATION_REQUIRED', message: 'Email or password is incorrect.', requestId: 'trace-1'
    }}), {status: 401})));
    await expect(selfHostedIdentityClient.login('user@example.com', 'bad')).rejects.toMatchObject({
      status: 401, code: 'AUTHENTICATION_REQUIRED', message: 'Email or password is incorrect.', requestId: 'trace-1'
    });
  });

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

  it('maps the returned revision to the default committee behavior update precondition', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-quorum_csrf=test-csrf');
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {creatorIsChair: true, operationMode: 'CHAIR_OPERATED', revision: 2}, meta: {requestId: 'request'}})}));
    vi.stubGlobal('fetch', fetchMock);

    await selfHostedIdentityClient.updateDefaultCommitteeBehavior({creatorIsChair: true, operationMode: 'CHAIR_OPERATED', revision: 1});

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/default-committee-behavior', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({creatorIsChair: true, operationMode: 'CHAIR_OPERATED', baseRevision: 1})
    }));
  });
});
