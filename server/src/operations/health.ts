import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import type {Pool} from 'pg';
import {migrationStatus} from '../db/migrations.js';

export interface ReadyCheckResult {
  ready: boolean;
  checks: {
    database: {
      status: 'ok' | 'error';
      migrationVersion?: number;
    };
    storage: {
      status: 'ok' | 'error';
    };
  };
}

export interface HealthService {
  ready(): Promise<ReadyCheckResult>;
}

export function createHealthService(options: {
  pool: Pool;
  migrationsDirectory: string;
  storagePath: string;
}): HealthService {
  return {
    async ready(): Promise<ReadyCheckResult> {
      let database: ReadyCheckResult['checks']['database'] = {status: 'error'};
      let storage: ReadyCheckResult['checks']['storage'] = {status: 'error'};

      try {
        await options.pool.query('SELECT 1');
        const migrations = await migrationStatus(options.pool, options.migrationsDirectory);
        if (migrations.ready) {
          database = {status: 'ok', migrationVersion: migrations.latestAppliedVersion};
        }
      } catch {
        database = {status: 'error'};
      }

      try {
        await access(options.storagePath, fsConstants.R_OK | fsConstants.W_OK);
        storage = {status: 'ok'};
      } catch {
        storage = {status: 'error'};
      }

      return {
        ready: database.status === 'ok' && storage.status === 'ok',
        checks: {database, storage}
      };
    }
  };
}
