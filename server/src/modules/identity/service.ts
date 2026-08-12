import {randomUUID} from 'node:crypto';
import {AppError} from '../../http/errors.js';
import {createTemporaryPassword, hashPassword, verifyPassword} from './password.js';
import {LoginRateLimiter} from './rate-limit.js';
import type {AuditContext, AuthenticatedSession, IdentityStore, IdentityUser, NewSession} from './store.js';
import {createOpaqueToken, hashOpaqueToken, hashSource} from './tokens.js';

export interface RequestIdentityContext {
  requestId: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface SessionResult {
  user: IdentityUser;
  sessionToken: string;
  csrfToken: string;
}

export interface IdentityServiceOptions {
  sessionTtlMs?: number;
  lockAfterAttempts?: number;
  lockMs?: number;
  now?: () => Date;
  rateLimiter?: LoginRateLimiter;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Enter a valid email address.'});
  }
  return email;
}

function displayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Enter a display name.'});
  }
  return name;
}

function requirePassword(password: string): void {
  if (password.length < 12 || password.length > 256) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Password must be at least 12 characters.'});
  }
}

function publicUser(user: IdentityUser): IdentityUser {
  return {...user};
}

export class IdentityService {
  private readonly sessionTtlMs: number;
  private readonly lockAfterAttempts: number;
  private readonly lockMs: number;
  private readonly now: () => Date;
  private readonly rateLimiter: LoginRateLimiter;

  constructor(private readonly store: IdentityStore, options: IdentityServiceOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
    this.lockAfterAttempts = options.lockAfterAttempts ?? 5;
    this.lockMs = options.lockMs ?? 15 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.rateLimiter = options.rateLimiter ?? new LoginRateLimiter();
  }

  bootstrapStatus(): Promise<boolean> {
    return this.store.bootstrapStatus();
  }

  ensureBootstrapSecret(): Promise<string | null> {
    return this.store.ensureBootstrapSecret();
  }

  async bootstrapAdmin(input: {secret?: string; email: string; displayName: string; password: string},
    context: RequestIdentityContext): Promise<SessionResult> {
    if (!input.secret) {
      throw new AppError({code: 'BAD_REQUEST', message: 'Bootstrap secret is required.'});
    }
    const email = normalizeEmail(input.email);
    const name = displayName(input.displayName);
    requirePassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const session = this.newSession(context);
    const user = await this.store.bootstrapAdmin({
      secretHash: hashOpaqueToken(input.secret),
      id: randomUUID(),
      email,
      displayName: name,
      passwordHash,
      session: session.record,
      audit: this.audit(context)
    });
    return {user: publicUser(user), sessionToken: session.token, csrfToken: createOpaqueToken()};
  }

  async login(input: {email: string; password: string; existingSessionToken?: string},
    context: RequestIdentityContext): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    const rateKey = `${email}:${context.sourceIp ?? 'unknown'}`;
    if (!this.rateLimiter.consume(rateKey)) {
      throw new AppError({code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.'});
    }

    const record = await this.store.findLogin(email);
    const now = this.now();
    if (record?.lockedUntil && record.lockedUntil > now) {
      throw new AppError({code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.'});
    }
    const valid = record ? await verifyPassword(record.passwordHash, input.password) : false;
    if (!record || record.status !== 'ACTIVE' || !valid) {
      if (record) {
        await this.store.recordLoginFailure(record.id, now, this.lockAfterAttempts, this.lockMs, this.audit(context));
      } else {
        await hashPassword(input.password || createOpaqueToken());
      }
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Email or password is incorrect.'});
    }

    const session = this.newSession(context);
    const user = await this.store.completeLogin({
      user: record,
      existingTokenHash: input.existingSessionToken ? hashOpaqueToken(input.existingSessionToken) : null,
      session: session.record,
      audit: this.audit(context)
    });
    return {user: publicUser(user), sessionToken: session.token, csrfToken: createOpaqueToken()};
  }

  async authenticate(sessionToken: string | undefined): Promise<AuthenticatedSession> {
    if (!sessionToken) {
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
    }
    const session = await this.store.authenticate(hashOpaqueToken(sessionToken), this.now());
    if (!session) {
      throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
    }
    return session;
  }

  async logout(sessionToken: string | undefined, context: RequestIdentityContext): Promise<void> {
    if (sessionToken) {
      await this.store.revokeSession(hashOpaqueToken(sessionToken), this.now(), this.audit(context));
    }
  }

  async elevateSession(auth: AuthenticatedSession, password: string,
    context: RequestIdentityContext): Promise<SessionResult> {
    const login = await this.store.findLogin(auth.user.email);
    if (!login || !(await verifyPassword(login.passwordHash, password))) {
      throw new AppError({code: 'FORBIDDEN', message: 'Password is incorrect.'});
    }
    const session = this.newSession(context);
    const user = await this.store.rotateSession({
      actor: auth,
      replacementSession: session.record,
      now: this.now(),
      audit: this.audit(context)
    });
    return {user, sessionToken: session.token, csrfToken: createOpaqueToken()};
  }

  async changePassword(auth: AuthenticatedSession, input: {currentPassword: string; newPassword: string},
    context: RequestIdentityContext): Promise<SessionResult> {
    requirePassword(input.newPassword);
    const login = await this.store.findLogin(auth.user.email);
    if (!login || !(await verifyPassword(login.passwordHash, input.currentPassword))) {
      throw new AppError({code: 'FORBIDDEN', message: 'Current password is incorrect.'});
    }
    const passwordHash = await hashPassword(input.newPassword);
    const session = this.newSession(context);
    const user = await this.store.changePassword({
      actor: auth,
      passwordHash,
      replacementSession: session.record,
      now: this.now(),
      audit: this.audit(context)
    });
    return {user, sessionToken: session.token, csrfToken: createOpaqueToken()};
  }

  async listUsers(auth: AuthenticatedSession): Promise<IdentityUser[]> {
    this.requireAdministrator(auth);
    return this.store.listUsers();
  }

  async createUser(auth: AuthenticatedSession, input: {email: string; displayName: string},
    context: RequestIdentityContext): Promise<{user: IdentityUser; temporaryPassword: string}> {
    this.requireAdministrator(auth);
    const temporaryPassword = createTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    try {
      const user = await this.store.createUser({
        actor: auth,
        id: randomUUID(),
        email: normalizeEmail(input.email),
        displayName: displayName(input.displayName),
        passwordHash,
        audit: this.audit(context)
      });
      return {user, temporaryPassword};
    } catch (error) {
      if ((error as {code?: string}).code === '23505') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This email address is already in use.'});
      }
      throw error;
    }
  }

  async resetPassword(auth: AuthenticatedSession, targetUserId: string,
    context: RequestIdentityContext): Promise<{user: IdentityUser; temporaryPassword: string}> {
    this.requireAdministrator(auth);
    const temporaryPassword = createTemporaryPassword();
    const user = await this.store.resetPassword({
      actor: auth,
      targetUserId,
      passwordHash: await hashPassword(temporaryPassword),
      now: this.now(),
      audit: this.audit(context)
    });
    if (!user) throw new AppError({code: 'NOT_FOUND', message: 'User not found.'});
    return {user, temporaryPassword};
  }

  async disableUser(auth: AuthenticatedSession, targetUserId: string, context: RequestIdentityContext): Promise<void> {
    this.requireAdministrator(auth);
    const result = await this.store.disableUser({actor: auth, targetUserId, now: this.now(), audit: this.audit(context)});
    if (result === 'not_found') throw new AppError({code: 'NOT_FOUND', message: 'User not found.'});
    if (result === 'system_admin') {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The system administrator cannot be disabled.'});
    }
  }

  async revokeUserSessions(auth: AuthenticatedSession, targetUserId: string,
    context: RequestIdentityContext): Promise<void> {
    this.requireAdministrator(auth);
    const found = await this.store.revokeUserSessions({actor: auth, targetUserId, now: this.now(), audit: this.audit(context)});
    if (!found) throw new AppError({code: 'NOT_FOUND', message: 'User not found.'});
  }

  private requireAdministrator(auth: AuthenticatedSession): void {
    if (auth.user.mustChangePassword) {
      throw new AppError({code: 'FORBIDDEN', message: 'Change the temporary password first.'});
    }
    if (!auth.user.isSystemAdmin) {
      throw new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
    }
  }

  private newSession(context: RequestIdentityContext): {token: string; record: NewSession} {
    const token = createOpaqueToken();
    const now = this.now();
    return {
      token,
      record: {
        id: randomUUID(),
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(now.getTime() + this.sessionTtlMs),
        ipHash: hashSource(context.sourceIp),
        userAgentSummary: context.userAgent?.slice(0, 240) ?? null
      }
    };
  }

  private audit(context: RequestIdentityContext): AuditContext {
    return {requestId: context.requestId, sourceIpHash: hashSource(context.sourceIp)};
  }
}
