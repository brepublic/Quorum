export type UserStatus = 'ACTIVE' | 'DISABLED' | 'ANONYMIZED';

export interface IdentityUser {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  isSystemAdmin: boolean;
  sessionVersion: number;
  mustChangePassword: boolean;
  createdAt: string;
  disabledAt: string | null;
}

export interface LoginRecord extends IdentityUser {
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: IdentityUser;
}

export interface NewSession {
  id: string;
  tokenHash: Buffer;
  expiresAt: Date;
  ipHash: Buffer | null;
  userAgentSummary: string | null;
}

export interface AuditContext {
  requestId: string;
  sourceIpHash: Buffer | null;
}

export interface IdentityStore {
  bootstrapStatus(): Promise<boolean>;
  ensureBootstrapSecret(): Promise<string | null>;
  bootstrapAdmin(input: {
    secretHash: Buffer;
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    session: NewSession;
    audit: AuditContext;
  }): Promise<IdentityUser>;
  findLogin(email: string): Promise<LoginRecord | null>;
  recordLoginFailure(userId: string, now: Date, lockAfterAttempts: number, lockMs: number, audit: AuditContext): Promise<void>;
  completeLogin(input: {
    user: LoginRecord;
    existingTokenHash: Buffer | null;
    session: NewSession;
    audit: AuditContext;
  }): Promise<IdentityUser>;
  rotateSession(input: {
    actor: AuthenticatedSession;
    replacementSession: NewSession;
    now: Date;
    audit: AuditContext;
  }): Promise<IdentityUser>;
  authenticate(tokenHash: Buffer, now: Date): Promise<AuthenticatedSession | null>;
  revokeSession(tokenHash: Buffer, now: Date, audit: AuditContext): Promise<void>;
  changePassword(input: {
    actor: AuthenticatedSession;
    passwordHash: string;
    replacementSession: NewSession;
    now: Date;
    audit: AuditContext;
  }): Promise<IdentityUser>;
  listUsers(): Promise<IdentityUser[]>;
  createUser(input: {
    actor: AuthenticatedSession;
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    audit: AuditContext;
  }): Promise<IdentityUser>;
  resetPassword(input: {
    actor: AuthenticatedSession;
    targetUserId: string;
    passwordHash: string;
    now: Date;
    audit: AuditContext;
  }): Promise<IdentityUser | null>;
  disableUser(input: {
    actor: AuthenticatedSession;
    targetUserId: string;
    now: Date;
    audit: AuditContext;
  }): Promise<'disabled' | 'not_found' | 'system_admin'>;
  revokeUserSessions(input: {
    actor: AuthenticatedSession;
    targetUserId: string;
    now: Date;
    audit: AuditContext;
  }): Promise<boolean>;
}
