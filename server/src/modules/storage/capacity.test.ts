// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {createLogger} from '../../logger';
import {StorageCapacityMonitor} from './capacity';

const blocksFor = (usedPercent: number) => async () => ({blocks: 100n, bavail: BigInt(100 - usedPercent), bsize: 10n});

describe('storage capacity protection', () => {
  it.each([
    [79, 'normal'], [80, 'warning'], [89, 'warning'], [90, 'critical']
  ] as const)('classifies %i percent as %s', async (used, state) => {
    const monitor = new StorageCapacityMonitor('/mounted/storage', 80, 90, createLogger(() => undefined), blocksFor(used));
    await expect(monitor.sample()).resolves.toEqual(expect.objectContaining({state, usagePercent: used,
      totalBytes: 1000, availableBytes: (100 - used) * 10}));
  });

  it('rejects new bytes at the critical threshold and when sampling fails', async () => {
    const critical = new StorageCapacityMonitor('/mounted/storage', 80, 90,
      createLogger(() => undefined), blocksFor(90));
    await expect(critical.assertWriteAllowed()).rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
    const unavailable = new StorageCapacityMonitor('/mounted/storage', 80, 90, createLogger(() => undefined),
      async () => {throw new Error('statfs unavailable');});
    await expect(unavailable.assertWriteAllowed()).rejects.toMatchObject({code: 'SERVICE_NOT_READY'});
  });

  it('logs only capacity state transitions without exposing the storage path', async () => {
    const lines: string[] = [];
    let used = 80;
    const monitor = new StorageCapacityMonitor('/secret/mounted/storage', 80, 90,
      createLogger(line => lines.push(line)), async () => blocksFor(used)());
    await monitor.sample();
    await monitor.sample();
    used = 79;
    await monitor.sample();
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('/secret/mounted/storage');
    expect(lines.map(line => JSON.parse(line).event)).toEqual(['storage.capacity.warning', 'storage.capacity.normal']);
  });
});
