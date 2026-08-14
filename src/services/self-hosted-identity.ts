export type SelfHostedUserStatus = 'ACTIVE' | 'DISABLED' | 'ANONYMIZED';

export interface SelfHostedUser {
  id: string;
  email: string;
  displayName: string;
  status: SelfHostedUserStatus;
  isSystemAdmin: boolean;
  sessionVersion: number;
  mustChangePassword: boolean;
  createdAt: string;
  disabledAt: string | null;
}

export interface AccountAnonymizationResult {
  user: SelfHostedUser;
  replacementUserId: string;
  transferred: {committees: number; countryTemplates: number; committeeTemplates: number; rulePackages: number};
}

interface ApiSuccess<T> {
  data: T;
  meta: {requestId: string};
}

interface ApiFailure {
  error: {code: string; message: string; requestId: string};
}

export class IdentityApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = 'IdentityApiError';
  }
}

export interface SelfHostedIdentityClient {
  bootstrapStatus(): Promise<boolean>;
  bootstrap(input: {secret: string; email: string; displayName: string; password: string}): Promise<SelfHostedUser>;
  me(): Promise<SelfHostedUser>;
  login(email: string, password: string): Promise<SelfHostedUser>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<SelfHostedUser>;
  elevate(password: string): Promise<SelfHostedUser>;
  listUsers(): Promise<SelfHostedUser[]>;
  createUser(email: string, displayName: string): Promise<{user: SelfHostedUser; temporaryPassword: string}>;
  resetPassword(userId: string): Promise<{user: SelfHostedUser; temporaryPassword: string}>;
  disableUser(userId: string): Promise<void>;
  revokeSessions(userId: string): Promise<void>;
  anonymizeUser(userId: string, replacementUserId: string, confirmationEmail: string): Promise<AccountAnonymizationResult>;
}

function cookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie.split(';').map(value => value.trim())
    .find(value => value.startsWith(prefix))?.slice(prefix.length);
}

async function request<T>(path: string, options: {
  method?: 'POST'; body?: Record<string, unknown>; csrf?: boolean; idempotencyKey?: string;
} = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.csrf) {
    const csrf = cookie('__Host-quorum_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  const payload = await response.json() as ApiSuccess<T> | ApiFailure;
  if (!response.ok || 'error' in payload) {
    const error = 'error' in payload ? payload.error : {code: 'INTERNAL_ERROR', message: 'Request failed.', requestId: undefined};
    throw new IdentityApiError(response.status, error.code, error.message, error.requestId);
  }
  return payload.data;
}

export const selfHostedIdentityClient: SelfHostedIdentityClient = {
  async bootstrapStatus() {
    return (await request<{initialized: boolean}>('/api/v1/bootstrap/status')).initialized;
  },
  async bootstrap(input) {
    return (await request<{user: SelfHostedUser}>('/api/v1/bootstrap/admin', {method: 'POST', body: input})).user;
  },
  async me() {
    return (await request<{user: SelfHostedUser}>('/api/v1/auth/me')).user;
  },
  async login(email, password) {
    return (await request<{user: SelfHostedUser}>('/api/v1/auth/login', {method: 'POST', body: {email, password}})).user;
  },
  async logout() {
    await request('/api/v1/auth/logout', {method: 'POST', csrf: true});
  },
  async changePassword(currentPassword, newPassword) {
    return (await request<{user: SelfHostedUser}>('/api/v1/auth/change-password', {
      method: 'POST', csrf: true, body: {currentPassword, newPassword}
    })).user;
  },
  async elevate(password) {
    return (await request<{user: SelfHostedUser}>('/api/v1/auth/elevate', {
      method: 'POST', csrf: true, body: {password}
    })).user;
  },
  async listUsers() {
    return (await request<{users: SelfHostedUser[]}>('/api/v1/admin/users')).users;
  },
  createUser(email, displayName) {
    return request('/api/v1/admin/users', {method: 'POST', csrf: true, body: {email, displayName}});
  },
  resetPassword(userId) {
    return request(`/api/v1/admin/users/${userId}/reset-password`, {method: 'POST', csrf: true});
  },
  async disableUser(userId) {
    await request(`/api/v1/admin/users/${userId}/disable`, {method: 'POST', csrf: true});
  },
  async revokeSessions(userId) {
    await request(`/api/v1/admin/users/${userId}/revoke-sessions`, {method: 'POST', csrf: true});
  },
  anonymizeUser(userId, replacementUserId, confirmationEmail) {
    return request(`/api/v1/admin/users/${userId}/anonymize`, {
      method: 'POST', csrf: true, idempotencyKey: crypto.randomUUID(), body: {replacementUserId, confirmationEmail}
    });
  }
};
