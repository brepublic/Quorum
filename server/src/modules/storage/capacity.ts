import {statfs} from 'node:fs/promises';
import type {Logger} from '../../logger.js';
import {AppError} from '../../http/errors.js';

export type StorageCapacityState = 'normal' | 'warning' | 'critical';

export interface StorageCapacitySnapshot {
  state: StorageCapacityState;
  usageRatio: number;
  usagePercent: number;
  totalBytes: number;
  availableBytes: number;
}

export interface StorageCapacityGuard {
  sample(): Promise<StorageCapacitySnapshot>;
  assertWriteAllowed(): Promise<StorageCapacitySnapshot>;
}

export type StorageCapacitySampler = (path: string) => Promise<{
  blocks: bigint;
  bavail: bigint;
  bsize: bigint;
}>;

const defaultSampler: StorageCapacitySampler = async path => {
  const stats = await statfs(path, {bigint: true});
  return {blocks: stats.blocks, bavail: stats.bavail, bsize: stats.bsize};
};

function finiteBytes(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

export class StorageCapacityMonitor implements StorageCapacityGuard {
  private previousState?: StorageCapacityState;
  private unavailable = false;

  constructor(readonly storagePath: string, readonly warningPercent: number, readonly criticalPercent: number,
    private readonly logger: Logger, private readonly sampler: StorageCapacitySampler = defaultSampler) {
    if (!Number.isInteger(warningPercent) || !Number.isInteger(criticalPercent)
      || warningPercent < 1 || warningPercent >= criticalPercent || criticalPercent > 100) {
      throw new Error('Storage capacity thresholds must be whole percentages with warning below critical.');
    }
  }

  async sample(): Promise<StorageCapacitySnapshot> {
    let stats: Awaited<ReturnType<StorageCapacitySampler>>;
    try {
      stats = await this.sampler(this.storagePath);
    } catch (error) {
      if (!this.unavailable) {
        this.logger.error('storage.capacity.sample_failed', {failureCode: 'STORAGE_CAPACITY_UNKNOWN'});
      }
      this.unavailable = true;
      throw error;
    }
    if (stats.blocks <= 0n || stats.bsize <= 0n || stats.bavail < 0n || stats.bavail > stats.blocks) {
      throw new Error('Storage capacity could not be measured.');
    }
    const usedBlocks = stats.blocks - stats.bavail;
    const usageRatio = Number(usedBlocks) / Number(stats.blocks);
    const usagePercent = Math.min(100, Math.max(0, usageRatio * 100));
    const state: StorageCapacityState = usagePercent >= this.criticalPercent
      ? 'critical' : usagePercent >= this.warningPercent ? 'warning' : 'normal';
    const snapshot = {
      state,
      usageRatio,
      usagePercent,
      totalBytes: finiteBytes(stats.blocks * stats.bsize),
      availableBytes: finiteBytes(stats.bavail * stats.bsize)
    };
    if (this.unavailable) this.logger.info('storage.capacity.sample_recovered', {state});
    this.unavailable = false;
    this.logTransition(snapshot);
    return snapshot;
  }

  async assertWriteAllowed(): Promise<StorageCapacitySnapshot> {
    let snapshot: StorageCapacitySnapshot;
    try {
      snapshot = await this.sample();
    } catch {
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'Storage capacity is unavailable.'});
    }
    if (snapshot.state === 'critical') {
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'Storage capacity is critically low.',
        details: {storageState: snapshot.state}, expose: true});
    }
    return snapshot;
  }

  private logTransition(snapshot: StorageCapacitySnapshot): void {
    if (snapshot.state === this.previousState) return;
    const previousState = this.previousState;
    this.previousState = snapshot.state;
    const fields = {state: snapshot.state, previousState, usagePercent: Number(snapshot.usagePercent.toFixed(2)),
      warningPercent: this.warningPercent, criticalPercent: this.criticalPercent};
    if (snapshot.state === 'normal') this.logger.info('storage.capacity.normal', fields);
    else this.logger.warn(`storage.capacity.${snapshot.state}`, fields);
  }
}
