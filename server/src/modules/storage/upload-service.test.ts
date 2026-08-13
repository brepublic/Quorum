// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {isUploadCleanupEligible} from './upload-service';

describe('upload cleanup eligibility', () => {
  const expired = new Date('2026-08-12T00:00:00.000Z');
  const future = new Date('2026-08-14T00:00:00.000Z');
  const now = new Date('2026-08-13T00:00:00.000Z');

  it('never treats the only uncommitted staging copy as ordinary expiry cleanup', () => {
    expect(isUploadCleanupEligible('CREATED', expired, now)).toBe(false);
    expect(isUploadCleanupEligible('RECEIVING', expired, now)).toBe(false);
    expect(isUploadCleanupEligible('STAGED', expired, now)).toBe(false);
  });

  it('allows only committed, cancelled, or expired failed uploads', () => {
    expect(isUploadCleanupEligible('COMMITTED', future, now)).toBe(true);
    expect(isUploadCleanupEligible('CANCELLED', future, now)).toBe(true);
    expect(isUploadCleanupEligible('FAILED', future, now)).toBe(false);
    expect(isUploadCleanupEligible('FAILED', expired, now)).toBe(true);
  });
});
