// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {STORAGE_HOST_STATUSES, STORAGE_PAIRING_PURPOSES} from './stage7';

describe('stage 7 Agent contracts', () => {
  it('freezes durable host and pairing states without task states', () => {
    expect(STORAGE_HOST_STATUSES).toEqual(['ACTIVE', 'DEGRADED', 'REVOKED']);
    expect(STORAGE_PAIRING_PURPOSES).toEqual(['INITIAL', 'TRANSFER']);
  });
});
