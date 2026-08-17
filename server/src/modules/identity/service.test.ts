// @vitest-environment node

import {beforeAll, describe, expect, it, vi} from 'vitest';
import {AppError} from '../../http/errors';
import {hashPassword} from './password';
import {IdentityService} from './service';
import type {AuthenticatedSession, IdentityStore, IdentityUser, LoginRecord} from './store';
import {hashOpaqueToken} from './tokens';

const now = new Date('2026-08-12T00:00:00.000Z');
const user: IdentityUser = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.com',
  displayName: 'User',
  status: 'ACTIVE',
  isSystemAdmin: false,
  sessionVersion: 1,
  mustChangePassword: true,
  createdAt: now.toISOString(),
  disabledAt: null
};
const admin: IdentityUser = {...user, id: '10000000-0000-4000-8000-000000000002', email: 'admin@example.com',
  displayName: 'Admin', isSystemAdmin: true, mustChangePassword: false};
let passwordHash = '';

beforeAll(async () => {
  passwordHash = await hashPassword('valid-password-123');
});

function store(overrides: Partial<IdentityStore> = {}): IdentityStore {
  return {
    bootstrapStatus: vi.fn(async () => true),
    ensureBootstrapSecret: vi.fn(async () => null),
    bootstrapAdmin: vi.fn(async () => admin),
    findLogin: vi.fn(async () => null),
    recordLoginFailure: vi.fn(async () => undefined),
    completeLogin: vi.fn(async input => input.user),
    rotateSession: vi.fn(async input => input.actor.user),
    authenticate: vi.fn(async () => null),
    revokeSession: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => ({...user, mustChangePassword: false, sessionVersion: 2})),
    listUsers: vi.fn(async () => []),
    createUser: vi.fn(async () => user),
    resetPassword: vi.fn(async () => user),
    disableUser: vi.fn(async () => 'disabled'),
    revokeUserSessions: vi.fn(async () => true),
    anonymizeUser: vi.fn(async () => ({
      user: {...user, email: '', displayName: '匿名账号', status: 'ANONYMIZED'},
      replacementUserId: admin.id,
      transferred: {committees: 0, countryTemplates: 0, committeeTemplates: 0, rulePackages: 0}
    })),
    ...overrides
  };
}

function loginRecord(overrides: Partial<LoginRecord> = {}): LoginRecord {
  return {...user, passwordHash, failedAttempts: 0, lockedUntil: null, ...overrides};
}

function auth(identity: IdentityUser): AuthenticatedSession {
  return {sessionId: 'session-id', user: identity};
}

describe('identity service policy', () => {
  it('requires a bootstrap secret before touching the store', async () => {
    const fake = store();
    const service = new IdentityService(fake, {now: () => now});

    await expect(service.bootstrapAdmin({email: 'admin@example.com', displayName: 'Admin', password: 'valid-password-123'},
      {requestId: 'request'})).rejects.toMatchObject({code: 'BAD_REQUEST'});
    expect(fake.bootstrapAdmin).not.toHaveBeenCalled();
  });

  it('rotates an existing Session token after successful login', async () => {
    const fake = store({findLogin: vi.fn(async () => loginRecord({mustChangePassword: false}))});
    const service = new IdentityService(fake, {now: () => now});
    const result = await service.login({email: user.email, password: 'valid-password-123', existingSessionToken: 'old-token'},
      {requestId: 'request'});

    expect(result.sessionToken).not.toBe('old-token');
    expect(fake.completeLogin).toHaveBeenCalledWith(expect.objectContaining({
      existingTokenHash: hashOpaqueToken('old-token'),
      session: expect.objectContaining({tokenHash: hashOpaqueToken(result.sessionToken)})
    }));
  });

  it('rotates the Session ID after password-confirmed elevation', async () => {
    const fake = store({findLogin: vi.fn(async () => loginRecord({...admin, passwordHash}))});
    const service = new IdentityService(fake, {now: () => now});
    const result = await service.elevateSession(auth(admin), 'valid-password-123', {requestId: 'request'});

    expect(fake.rotateSession).toHaveBeenCalledWith(expect.objectContaining({
      actor: auth(admin),
      replacementSession: expect.objectContaining({tokenHash: hashOpaqueToken(result.sessionToken)})
    }));
  });

  it('uses the authenticated temporary-password Session to set the permanent password', async () => {
    const fake = store();
    const service = new IdentityService(fake, {now: () => now});
    const result = await service.changePassword(auth(user), {newPassword: 'new-password-123'}, {requestId: 'request'});

    expect(fake.findLogin).not.toHaveBeenCalled();
    expect(fake.changePassword).toHaveBeenCalledWith(expect.objectContaining({
      actor: auth(user), replacementSession: expect.objectContaining({tokenHash: hashOpaqueToken(result.sessionToken)})
    }));
  });

  it('still verifies the current password for a voluntary password change', async () => {
    const permanentUser = {...user, mustChangePassword: false};
    const fake = store({findLogin: vi.fn(async () => loginRecord({...permanentUser, passwordHash}))});
    const service = new IdentityService(fake, {now: () => now});

    await service.changePassword(auth(permanentUser), {
      currentPassword: 'valid-password-123', newPassword: 'new-password-123'
    }, {requestId: 'request'});
    expect(fake.findLogin).toHaveBeenCalledWith(permanentUser.email);
  });

  it('enforces account lock and returns a stable rate-limit error', async () => {
    const fake = store({findLogin: vi.fn(async () => loginRecord({lockedUntil: new Date(now.getTime() + 60_000)}))});
    const service = new IdentityService(fake, {now: () => now});

    await expect(service.login({email: user.email, password: 'valid-password-123'}, {requestId: 'request'}))
      .rejects.toMatchObject({code: 'RATE_LIMITED', status: 429});
    expect(fake.completeLogin).not.toHaveBeenCalled();
  });

  it('blocks ordinary users and temporary-password sessions from administrator commands', async () => {
    const fake = store();
    const service = new IdentityService(fake, {now: () => now});

    await expect(service.listUsers(auth({...user, mustChangePassword: false}))).rejects.toMatchObject({code: 'FORBIDDEN'});
    await expect(service.listUsers(auth({...admin, mustChangePassword: true}))).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(fake.listUsers).not.toHaveBeenCalled();
  });

  it('does not permit the unique system administrator to be disabled', async () => {
    const fake = store({disableUser: vi.fn(async () => 'system_admin')});
    const service = new IdentityService(fake, {now: () => now});

    await expect(service.disableUser(auth(admin), admin.id, {requestId: 'request'}))
      .rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('requires disablement and binds account anonymization to an idempotent resource transfer request', async () => {
    const anonymizeUser = vi.fn(async () => 'not_disabled' as const);
    const fake = store({anonymizeUser});
    const service = new IdentityService(fake, {now: () => now});

    await expect(service.anonymizeUser(auth(admin), user.id, {
      replacementUserId: admin.id,
      confirmationEmail: 'USER@example.com '
    }, 'anonymize-request', {requestId: 'request'})).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
    expect(anonymizeUser).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: user.id,
      replacementUserId: admin.id,
      confirmationEmail: 'user@example.com',
      idempotencyKey: 'anonymize-request',
      requestHash: expect.any(Buffer)
    }));
  });

  it('returns unified authentication and authorization errors without secrets', () => {
    const authentication = new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
    const authorization = new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
    expect(authentication.status).toBe(401);
    expect(authorization.status).toBe(403);
    expect(JSON.stringify([authentication, authorization])).not.toContain('valid-password-123');
  });
});
