import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import type {Pool} from 'pg';
import {migrationStatus} from '../db/migrations.js';
import type {StorageCapacityGuard} from '../modules/storage/capacity.js';

export interface ReadyCheckResult {
  ready: boolean;
  checks: {
    database: {
      status: 'ok' | 'error';
      migrationVersion?: number;
    };
    storage: {
      status: 'ok' | 'warning' | 'critical' | 'error';
      usagePercent?: number;
      availableBytes?: number;
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
  capacity?: StorageCapacityGuard;
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
        const capacity = await options.capacity?.sample();
        const status: ReadyCheckResult['checks']['storage']['status'] = capacity?.availableBytes === 0
          ? 'error' : capacity?.state === 'normal' ? 'ok' : capacity?.state ?? 'ok';
        storage = {status, ...(capacity ? {usagePercent: Number(capacity.usagePercent.toFixed(2)),
          availableBytes: capacity.availableBytes} : {})};
      } catch {
        storage = {status: 'error'};
      }

      return {
        ready: database.status === 'ok' && storage.status !== 'error',
        checks: {database, storage}
      };
    }
  };
}
