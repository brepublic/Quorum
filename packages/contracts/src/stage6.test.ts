// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {
  FILE_BLOB_DURABILITY_STATES,
  FILE_ENTRY_STATUSES,
  FILE_UPLOAD_STATUSES,
  STORAGE_BINDING_STATUSES,
  STORAGE_PROVIDER_TYPES
} from './stage6';

describe('stage 6 storage contracts', () => {
  it('publishes only the phase 6 providers and explicit durable states', () => {
    expect(STORAGE_PROVIDER_TYPES).toEqual(['SERVER_VOLUME', 'S3_COMPATIBLE']);
    expect(STORAGE_PROVIDER_TYPES).not.toContain('CHAIR_AGENT');
    expect(STORAGE_BINDING_STATUSES).toContain('ACTIVE');
    expect(FILE_ENTRY_STATUSES).toEqual(['UPLOAD_COMPLETE', 'PENDING_REVIEW', 'PUBLISHED', 'DELETED']);
    expect(FILE_BLOB_DURABILITY_STATES).toEqual(['COMMITTED', 'DELETE_PENDING', 'DELETED', 'FAILED']);
    expect(FILE_UPLOAD_STATUSES).toEqual(['CREATED', 'RECEIVING', 'STAGED', 'COMMITTED', 'CANCELLED', 'FAILED']);
  });
});
