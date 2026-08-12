import {resolve} from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  version: string;
  databaseUrl: string;
  migrationsDirectory: string;
  storagePath: string;
  shutdownGraceMs: number;
  allowedOrigins: string[];
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
  return {
    host: env.HOST || '0.0.0.0',
    port: integer(env.PORT, 3000, 'PORT'),
    version: env.QUORUM_VERSION || '0.1.0-self-hosted',
    databaseUrl: databaseUrl(env),
    migrationsDirectory: resolve(env.QUORUM_MIGRATIONS_DIR || 'server/migrations'),
    storagePath: resolve(env.QUORUM_STORAGE_PATH || 'server/.local/storage'),
    shutdownGraceMs: integer(env.SHUTDOWN_GRACE_MS, 10_000, 'SHUTDOWN_GRACE_MS'),
    allowedOrigins
  };
}
