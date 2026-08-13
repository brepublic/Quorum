// @vitest-environment node

import type {Pool} from 'pg';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../../logger';
import {Stage6MaintenanceService, startStorageMaintenanceWorker} from './maintenance-service';

describe('storage maintenance worker and metrics', () => {
  it('prioritizes durable blob deletion before staging cleanup', async () => {
    const files = {processNextDeleteJob: vi.fn().mockResolvedValue({status: 'COMPLETED', failureCode: null})};
    const staging = {remove: vi.fn()};
    const service = new Stage6MaintenanceService({} as Pool, staging as never, files as never,
      {sample: vi.fn(), assertWriteAllowed: vi.fn()} as never, createLogger(() => undefined));
    await expect(service.processNext()).resolves.toEqual({kind: 'BLOB_DELETE', outcome: 'SUCCEEDED', failureCode: null});
    expect(staging.remove).not.toHaveBeenCalled();
  });

  it('renders bounded storage and cleanup metrics without paths or filenames', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows: [{blob_delete: 2, upload_staging: 3, migration_staging: 4}]})
      .mockResolvedValueOnce({rows: [{resource_type: 'BLOB_DELETE', outcome: 'SUCCEEDED', count: 5}]});
    const capacity = {sample: vi.fn().mockResolvedValue({state: 'warning', usageRatio: 0.8, usagePercent: 80,
      totalBytes: 1000, availableBytes: 200}), assertWriteAllowed: vi.fn()};
    const service = new Stage6MaintenanceService({query} as unknown as Pool, {} as never,
      {processNextDeleteJob: vi.fn()} as never, capacity as never, createLogger(() => undefined));
    const output = await service.renderMetrics();
    expect(output).toContain('quorum_storage_usage_ratio 0.8');
    expect(output).toContain('quorum_storage_cleanup_queue{kind="upload_staging"} 3');
    expect(output).toContain('quorum_storage_cleanup_total{kind="blob_delete",outcome="succeeded"} 5');
    expect(output).not.toMatch(/path|filename|secret/i);
  });

  it('drains work serially and stops cleanly', async () => {
    vi.useFakeTimers();
    const processNext = vi.fn().mockResolvedValueOnce({kind: 'BLOB_DELETE'}).mockResolvedValue(null);
    const stop = startStorageMaintenanceWorker({processNext} as never, createLogger(() => undefined), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(processNext).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(processNext).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(processNext).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
