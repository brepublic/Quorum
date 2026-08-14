// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {Readable} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {createRequestHandler} from './app';
import {AppError} from './errors';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {IdentityUser} from '../modules/identity/store';

const user: IdentityUser = {
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

class TestResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  body = '';
  readonly headers = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  end(body?: string): this {
    this.headersSent = true;
    this.body = body ?? '';
    queueMicrotask(() => this.emit('finish'));
    return this;
  }

  destroy(): this {
    return this;
  }
}

function fakeIdentity(overrides: Record<string, unknown> = {}): IdentityService {
  return {
    bootstrapStatus: vi.fn(async () => true),
    bootstrapAdmin: vi.fn(async () => ({user, sessionToken: 'new-session', csrfToken: 'new-csrf'})),
    login: vi.fn(async () => ({user, sessionToken: 'new-session', csrfToken: 'new-csrf'})),
    authenticate: vi.fn(async () => ({sessionId: 'session-id', user})),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => ({user, sessionToken: 'changed-session', csrfToken: 'changed-csrf'})),
    elevateSession: vi.fn(async () => ({user, sessionToken: 'elevated-session', csrfToken: 'elevated-csrf'})),
    listUsers: vi.fn(async () => [user]),
    createUser: vi.fn(async () => ({user, temporaryPassword: 'temporary-password'})),
    resetPassword: vi.fn(async () => ({user, temporaryPassword: 'temporary-password'})),
    disableUser: vi.fn(async () => undefined),
    revokeUserSessions: vi.fn(async () => undefined),
    anonymizeUser: vi.fn(async () => ({user: {...user, email: '', displayName: '匿名账号', status: 'ANONYMIZED'}})),
    ...overrides
  } as unknown as IdentityService;
}

async function request(identity: IdentityService, options: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  operationsStatus?: {status: (auth: unknown) => Promise<unknown>};
}) {
  const logs: string[] = [];
  const handler = createRequestHandler({
    health: {ready: async () => ({ready: true, checks: {database: {status: 'ok', migrationVersion: 2}, storage: {status: 'ok'}}})},
    logger: createLogger(line => logs.push(line)),
    version: 'test',
    databaseMigrationVersion: 2,
    identity,
    operationsStatus: options.operationsStatus as never,
    allowedOrigins: ['https://quorum.example.com']
  });
  const body = options.body ? JSON.stringify(options.body) : '';
  const incoming = Readable.from(body ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(incoming, {
    method: options.method ?? 'GET',
    url: options.path,
    headers: options.headers ?? {},
    socket: {remoteAddress: '127.0.0.1'}
  });
  const response = new TestResponse();
  const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse);
  await finished;
  return {status: response.statusCode, headers: response.headers, text: response.body,
    json: JSON.parse(response.body) as Record<string, unknown>, logs};
}

describe('identity HTTP security boundary', () => {
  it('authenticates the administrator operations status route', async () => {
    const identity = fakeIdentity();
    const operationsStatus = {status: vi.fn(async () => ({storage: {state: 'normal'}}))};
    const response = await request(identity, {
      path: '/api/v1/admin/operations/status',
      headers: {cookie: '__Host-quorum_session=session'},
      operationsStatus
    });

    expect(response.status).toBe(200);
    expect(identity.authenticate).toHaveBeenCalledWith('session');
    expect(operationsStatus.status).toHaveBeenCalledWith(expect.objectContaining({user}));
  });

  it('rotates the login Session and sets secure Cookie attributes', async () => {
    const identity = fakeIdentity();
    const response = await request(identity, {
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: {origin: 'https://quorum.example.com', cookie: '__Host-quorum_session=old-session'},
      body: {email: user.email, password: 'password'}
    });
    const setCookie = (response.headers.get('set-cookie') as readonly string[]).join('; ');

    expect(response.status).toBe(200);
    expect(identity.login).toHaveBeenCalledWith(expect.objectContaining({existingSessionToken: 'old-session'}), expect.anything());
    expect(setCookie).toContain('__Host-quorum_session=new-session');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('old-session');
  });

  it('rejects missing or incorrect CSRF tokens on authenticated writes', async () => {
    const identity = fakeIdentity();
    const headers = {origin: 'https://quorum.example.com', cookie: '__Host-quorum_session=session; __Host-quorum_csrf=expected'};
    const missing = await request(identity, {path: '/api/v1/admin/users', method: 'POST', headers,
      body: {email: 'new@example.com', displayName: 'New'}});
    const wrong = await request(identity, {path: '/api/v1/admin/users', method: 'POST',
      headers: {...headers, 'x-csrf-token': 'wrong'}, body: {email: 'new@example.com', displayName: 'New'}});

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(identity.createUser).not.toHaveBeenCalled();
  });

  it('accepts a matching CSRF token and rejects a non-allowed Origin', async () => {
    const identity = fakeIdentity();
    const cookie = '__Host-quorum_session=session; __Host-quorum_csrf=expected';
    const rejected = await request(identity, {path: '/api/v1/admin/users', method: 'POST',
      headers: {origin: 'https://attacker.example', cookie, 'x-csrf-token': 'expected'},
      body: {email: 'new@example.com', displayName: 'New'}});
    const accepted = await request(identity, {path: '/api/v1/admin/users', method: 'POST',
      headers: {origin: 'https://quorum.example.com', cookie, 'x-csrf-token': 'expected'},
      body: {email: 'new@example.com', displayName: 'New'}});

    expect(rejected.status).toBe(403);
    expect(accepted.status).toBe(201);
    expect(identity.createUser).toHaveBeenCalledTimes(1);
  });

  it('routes account anonymization with CSRF, server actor and an idempotency key', async () => {
    const identity = fakeIdentity();
    const response = await request(identity, {
      path: `/api/v1/admin/users/${user.id}/anonymize`,
      method: 'POST',
      headers: {
        origin: 'https://quorum.example.com',
        cookie: '__Host-quorum_session=session; __Host-quorum_csrf=expected',
        'x-csrf-token': 'expected',
        'idempotency-key': 'account-disposition'
      },
      body: {replacementUserId: '20000000-0000-4000-8000-000000000001', confirmationEmail: user.email}
    });

    expect(response.status).toBe(200);
    expect(identity.anonymizeUser).toHaveBeenCalledWith(expect.objectContaining({user}), user.id, {
      replacementUserId: '20000000-0000-4000-8000-000000000001', confirmationEmail: user.email
    }, 'account-disposition', expect.anything());
  });

  it('returns the unified 401 and does not leak internal failures', async () => {
    const unauthorized = fakeIdentity({authenticate: vi.fn(async () => {
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
    })});
    const response = await request(unauthorized, {path: '/api/v1/auth/me'});
    expect(response.status).toBe(401);
    expect(response.json).toEqual({error: expect.objectContaining({code: 'AUTHENTICATION_REQUIRED', requestId: expect.any(String)})});

    const failed = fakeIdentity({bootstrapAdmin: vi.fn(async () => {
      throw new Error('stack includes bootstrap-secret-value');
    })});
    const internal = await request(failed, {path: '/api/v1/bootstrap/admin', method: 'POST',
      headers: {origin: 'https://quorum.example.com'},
      body: {secret: 'bootstrap-secret-value', email: user.email, displayName: 'Admin', password: 'password'}});
    expect(internal.status).toBe(500);
    expect(internal.text).not.toContain('bootstrap-secret-value');
    expect(internal.text).not.toContain('stack');
  });

  it('does not expose a registration_requests creation route', async () => {
    const response = await request(fakeIdentity(), {path: '/api/v1/registration_requests', method: 'POST',
      headers: {origin: 'https://quorum.example.com'}, body: {email: 'public@example.com'}});
    expect([404, 405]).toContain(response.status);
  });
});
