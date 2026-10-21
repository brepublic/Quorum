import {isTemporaryFailure, requestWithPolicy} from './request-policy';
import type {ApiErrorBody} from '@quorum/contracts';
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

export type {DefaultCommitteeBehavior} from '@quorum/contracts';
import type {DefaultCommitteeBehavior} from '@quorum/contracts';

interface ApiSuccess<T> {
  data: T;
  meta: {requestId: string};
}

interface ApiFailure {
  error: ApiErrorBody['error'];
}

export class IdentityApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string,
    readonly localization?: Pick<ApiErrorBody['error'], 'reason' | 'params' | 'fieldErrors'>) {
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
  changePassword(newPassword: string, currentPassword?: string): Promise<SelfHostedUser>;
  elevate(password: string): Promise<SelfHostedUser>;
  listUsers(): Promise<SelfHostedUser[]>;
  getDefaultCommitteeBehavior(): Promise<DefaultCommitteeBehavior>;
  updateDefaultCommitteeBehavior(input: DefaultCommitteeBehavior): Promise<DefaultCommitteeBehavior>;
  createUser(email: string, displayName: string, temporaryPassword?: string): Promise<{user: SelfHostedUser; temporaryPassword: string}>;
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
  method?: 'POST' | 'PUT'; body?: Record<string, unknown>; csrf?: boolean; idempotencyKey?: string;
} = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.csrf) {
    const csrf = cookie('__Host-quorum_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return requestWithPolicy(async signal => {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin', signal,
      headers,
      ...(options.body ? {body: JSON.stringify(options.body)} : {})
    });
  } catch {
    throw new IdentityApiError(0, 'NETWORK_ERROR', 'Unable to connect. Check your network and try again.');
  }
  let payload: ApiSuccess<T> | ApiFailure;
  try {
    payload = await response.json();
  } catch {
    throw new IdentityApiError(response.status, response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR',
      'The server returned an invalid response. Try again later.');
  }
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error
      && typeof payload.error.code === 'string' && typeof payload.error.message === 'string') {
    throw new IdentityApiError(response.status, payload.error.code, payload.error.message, payload.error.requestId, payload.error);
  }
  if (!response.ok) {
    throw new IdentityApiError(response.status, 'HTTP_ERROR', 'Request failed. Try again later.');
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload) || 'error' in payload) {
    throw new IdentityApiError(response.status, 'INVALID_RESPONSE', 'The server returned an invalid response. Try again later.');
  }
  return payload.data;
  }, {read: !options.method, repeatable: Boolean(options.idempotencyKey)});
}

const LOGOUT_KEY = 'quorum-local-logout';
let sessionId: string | undefined;
export function isLocallyLoggedOut() {return localStorage.getItem(LOGOUT_KEY) !== null;}
export function recordLocalLogout() {
  localStorage.setItem(LOGOUT_KEY, sessionId ?? localStorage.getItem(LOGOUT_KEY) ?? 'pending');
  document.cookie='__Host-quorum_local_logout=1; Path=/; Secure; SameSite=Lax; Max-Age=604800';
}
function acceptSession(result: {user: SelfHostedUser; sessionId?: string}) {
  sessionId = result.sessionId;
  localStorage.removeItem(LOGOUT_KEY);
  document.cookie='__Host-quorum_local_logout=; Path=/; Secure; SameSite=Lax; Max-Age=0';
  return result.user;
}

export const selfHostedIdentityClient: SelfHostedIdentityClient = {
  async bootstrapStatus() {
    return (await request<{initialized: boolean}>('/api/v1/bootstrap/status')).initialized;
  },
  async bootstrap(input) {
    return acceptSession(await request('/api/v1/bootstrap/admin', {method: 'POST', body: input}));
  },
  async me() {
    if (isLocallyLoggedOut()) throw new IdentityApiError(401, 'AUTHENTICATION_REQUIRED', 'Please log in again.');
    const result = await request<{user: SelfHostedUser; sessionId?: string}>('/api/v1/auth/me');
    sessionId = result.sessionId;
    return result.user;
  },
  async login(email, password) {
    try {return acceptSession(await request('/api/v1/auth/login', {method: 'POST', body: {email, password}}));}
    catch (error) {
      if (isTemporaryFailure(error)) {
        try {return acceptSession(await request('/api/v1/auth/me'));} catch { /* Keep the original login error. */ }
      }
      throw error;
    }
  },
  async logout() {
    recordLocalLogout();
    try {await request('/api/v1/auth/logout', {method: 'POST', csrf: true,
      body: {localLogout: true, sessionId: sessionId ?? localStorage.getItem(LOGOUT_KEY)},
      idempotencyKey: crypto.randomUUID()});}
    catch (error) {if (!(error instanceof IdentityApiError && error.status === 401)) throw error;}
  },
  async changePassword(newPassword, currentPassword) {
    return acceptSession(await request('/api/v1/auth/change-password', {
      method: 'POST', csrf: true, body: {...(currentPassword ? {currentPassword} : {}), newPassword}
    }));
  },
  async elevate(password) {
    return acceptSession(await request('/api/v1/auth/elevate', {
      method: 'POST', csrf: true, body: {password}
    }));
  },
  async listUsers() {
    return (await request<{users: SelfHostedUser[]}>('/api/v1/admin/users')).users;
  },
  getDefaultCommitteeBehavior() {
    return request<DefaultCommitteeBehavior>('/api/v1/admin/default-committee-behavior');
  },
  updateDefaultCommitteeBehavior(input) {
    const {revision, ...settings} = input;
    return request<DefaultCommitteeBehavior>('/api/v1/admin/default-committee-behavior', {
      method: 'PUT', csrf: true, body: {...settings, baseRevision: revision}
    });
  },
  createUser(email, displayName, temporaryPassword) {
    return request('/api/v1/admin/users', {method: 'POST', csrf: true, body: {email, displayName, ...(temporaryPassword ? {temporaryPassword} : {})}});
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

export interface ThemeSettings {enabled: boolean; revision: number}

export function getThemeSettings(): Promise<ThemeSettings> {
  return request<ThemeSettings>('/api/v1/theme-settings');
}

export function updateThemeSettings(settings: ThemeSettings): Promise<ThemeSettings> {
  return request<ThemeSettings>('/api/v1/admin/theme-settings', {
    method: 'PUT', csrf: true, body: {enabled: settings.enabled, baseRevision: settings.revision}
  });
}
