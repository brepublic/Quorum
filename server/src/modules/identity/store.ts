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

export interface IdentityResourceTransferCounts {
  committees: number;
  countryTemplates: number;
  committeeTemplates: number;
  rulePackages: number;
}

export interface IdentityAnonymizationResult {
  user: IdentityUser;
  replacementUserId: string;
  transferred: IdentityResourceTransferCounts;
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
  }): Promise<IdentityUser | 'not_active' | null>;
  disableUser(input: {
    actor: AuthenticatedSession;
    targetUserId: string;
    now: Date;
    audit: AuditContext;
  }): Promise<'disabled' | 'not_found' | 'system_admin' | 'not_active'>;
  revokeUserSessions(input: {
    actor: AuthenticatedSession;
    targetUserId: string;
    now: Date;
    audit: AuditContext;
  }): Promise<boolean>;
  anonymizeUser(input: {
    actor: AuthenticatedSession;
    targetUserId: string;
    replacementUserId: string;
    confirmationEmail: string;
    idempotencyKey: string;
    requestHash: Buffer;
    now: Date;
    audit: AuditContext;
  }): Promise<IdentityAnonymizationResult | 'not_found' | 'system_admin' | 'not_disabled' | 'invalid_replacement'
    | 'confirmation_mismatch' | 'deletion_in_progress' | 'idempotency_conflict'>;
}
