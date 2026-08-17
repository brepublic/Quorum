import {resolve} from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  version: string;
  databaseUrl: string;
  migrationsDirectory: string;
  storagePath: string;
  maxFileBytes: number;
  maxUploadRequestBytes: number;
  uploadTtlSeconds: number;
  storageWarningPercent: number;
  storageCriticalPercent: number;
  storageMasterKey: Buffer | null;
  storageMasterKeyVersion: number;
  shutdownGraceMs: number;
  retentionSessionDays: number;
  retentionIdentityIdempotencyDays: number;
  retentionSecretDays: number;
  retentionRegistrationDays: number;
  allowedOrigins: string[];
}

function storageMasterKey(env: NodeJS.ProcessEnv): Buffer | null {
  const encoded = env.QUORUM_STORAGE_MASTER_KEY;
  if (!encoded) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('QUORUM_STORAGE_MASTER_KEY must be an unpadded base64url-encoded 32-byte key.');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new Error('QUORUM_STORAGE_MASTER_KEY must be an unpadded base64url-encoded 32-byte key.');
  }
  return key;
}

function databaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
  for (const name of required) {
    if (!env[name]) {
      throw new Error(`DATABASE_URL or ${required.join(', ')} must be configured.`);
    }
  }
  const user = encodeURIComponent(env.DB_USER as string);
  const password = encodeURIComponent(env.DB_PASSWORD as string);
  const host = env.DB_HOST as string;
  const port = integer(env.DB_PORT, 5432, 'DB_PORT');
  const name = encodeURIComponent(env.DB_NAME as string);
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowedOrigins = (env.QUORUM_ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('QUORUM_ALLOWED_ORIGINS must contain comma-separated HTTP origins.');
    }
  }
  const maxFileBytes = integer(env.QUORUM_MAX_FILE_BYTES, 20 * 1024 * 1024, 'QUORUM_MAX_FILE_BYTES');
  const maxUploadRequestBytes = integer(env.QUORUM_MAX_UPLOAD_REQUEST_BYTES,
    21 * 1024 * 1024, 'QUORUM_MAX_UPLOAD_REQUEST_BYTES');
  if (maxUploadRequestBytes < maxFileBytes) {
    throw new Error('QUORUM_MAX_UPLOAD_REQUEST_BYTES must be at least QUORUM_MAX_FILE_BYTES.');
  }
  const masterKey = storageMasterKey(env);
  const storageWarningPercent = integer(env.QUORUM_STORAGE_WARNING_PERCENT, 80,
    'QUORUM_STORAGE_WARNING_PERCENT');
  const storageCriticalPercent = integer(env.QUORUM_STORAGE_CRITICAL_PERCENT, 90,
    'QUORUM_STORAGE_CRITICAL_PERCENT');
  if (storageWarningPercent >= storageCriticalPercent || storageCriticalPercent > 100) {
    throw new Error('Storage thresholds must be percentages with warning below critical.');
  }
  return {
    host: env.HOST || '0.0.0.0',
    port: integer(env.PORT, 3000, 'PORT'),
    version: env.QUORUM_VERSION || '0.1.0-self-hosted',
    databaseUrl: databaseUrl(env),
    migrationsDirectory: resolve(env.QUORUM_MIGRATIONS_DIR || 'server/migrations'),
    storagePath: resolve(env.QUORUM_STORAGE_PATH || 'server/.local/storage'),
    maxFileBytes,
    maxUploadRequestBytes,
    uploadTtlSeconds: integer(env.QUORUM_UPLOAD_TTL_SECONDS, 24 * 60 * 60, 'QUORUM_UPLOAD_TTL_SECONDS'),
    storageWarningPercent,
    storageCriticalPercent,
    storageMasterKey: masterKey,
    storageMasterKeyVersion: masterKey
      ? integer(env.QUORUM_STORAGE_MASTER_KEY_VERSION, 1, 'QUORUM_STORAGE_MASTER_KEY_VERSION')
      : 1,
    shutdownGraceMs: integer(env.SHUTDOWN_GRACE_MS, 10_000, 'SHUTDOWN_GRACE_MS'),
    retentionSessionDays: integer(env.QUORUM_RETENTION_SESSION_DAYS, 30, 'QUORUM_RETENTION_SESSION_DAYS'),
    retentionIdentityIdempotencyDays: integer(env.QUORUM_RETENTION_IDEMPOTENCY_DAYS, 30,
      'QUORUM_RETENTION_IDEMPOTENCY_DAYS'),
    retentionSecretDays: integer(env.QUORUM_RETENTION_SECRET_DAYS, 7, 'QUORUM_RETENTION_SECRET_DAYS'),
    retentionRegistrationDays: integer(env.QUORUM_RETENTION_REGISTRATION_DAYS, 90,
      'QUORUM_RETENTION_REGISTRATION_DAYS'),
    allowedOrigins
  };
}
