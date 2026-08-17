import type {ApiErrorCode} from './registry.js';

export interface ApiMeta {
  requestId: string;
}

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export type HealthStatus = 'ok' | 'not_ready';

export interface LiveHealth {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
}

export interface ReadyHealth {
  status: 'ok';
  checks: {
    database: {
      status: 'ok';
      migrationVersion: number;
    };
    storage: {
      status: 'ok';
    };
  };
}

export interface VersionInfo {
  version: string;
  contractVersion: number;
  ruleSchemaVersion: number;
  databaseMigrationVersion: number;
}

export type IdentityUserStatus = 'ACTIVE' | 'DISABLED' | 'ANONYMIZED';

export interface CurrentIdentity {
  id: string;
  email: string;
  displayName: string;
  status: IdentityUserStatus;
  isSystemAdmin: boolean;
  sessionVersion: number;
  mustChangePassword: boolean;
  createdAt: string;
  disabledAt: string | null;
}

export interface IdentitySessionData {
  user: CurrentIdentity;
  csrfToken: string;
}

export interface BootstrapStatus {
  initialized: boolean;
}

export function success<T>(data: T, requestId: string): ApiSuccess<T> {
  return {data, meta: {requestId}};
}
