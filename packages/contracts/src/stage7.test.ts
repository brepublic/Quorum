// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {
  STORAGE_AGENT_TASK_STATUSES,
  STORAGE_AGENT_TASK_TYPES,
  STORAGE_HOST_STATUSES,
  STORAGE_PAIRING_PURPOSES
} from './stage7';

describe('stage 7 Agent contracts', () => {
  it('freezes durable host and pairing states', () => {
    expect(STORAGE_HOST_STATUSES).toEqual(['ACTIVE', 'DEGRADED', 'REVOKED']);
    expect(STORAGE_PAIRING_PURPOSES).toEqual(['INITIAL', 'TRANSFER']);
  });

  it('freezes durable task types and explicit retry states', () => {
    expect(STORAGE_AGENT_TASK_TYPES).toEqual(['STORE_BLOB', 'UPLOAD_BLOB', 'DELETE_FILE']);
    expect(STORAGE_AGENT_TASK_STATUSES).toEqual([
      'PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED', 'FAILED', 'CANCELLED'
    ]);
  });
});
