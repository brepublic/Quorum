import {describe, expect, it} from 'vitest';
import {idempotencyLockKey} from './database';

describe('idempotency advisory lock key', () => {
  it('encodes each component without PostgreSQL-invalid NUL bytes', () => {
    const key = idempotencyLockKey('user-id', 'POST /api/v1/committees', 'request-key');

    expect(key).not.toContain('\0');
    expect(JSON.parse(key)).toEqual(['user-id', 'POST /api/v1/committees', 'request-key']);
  });

  it('keeps component boundaries unambiguous', () => {
    expect(idempotencyLockKey('a', 'bc', 'd')).not.toBe(idempotencyLockKey('ab', 'c', 'd'));
  });
});
