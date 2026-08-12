// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {LoginRateLimiter} from './rate-limit';

describe('login rate limiter', () => {
  it('rejects excess attempts and recovers after the window', () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter({maximumAttempts: 2, windowMs: 10_000, now: () => now});

    expect(limiter.consume('same-client')).toBe(true);
    expect(limiter.consume('same-client')).toBe(true);
    expect(limiter.consume('same-client')).toBe(false);
    now += 10_001;
    expect(limiter.consume('same-client')).toBe(true);
  });
});
