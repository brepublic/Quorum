// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {createOpaqueToken, hashOpaqueToken} from './tokens';

describe('opaque identity tokens', () => {
  it('stores a deterministic hash instead of the session token', () => {
    const token = createOpaqueToken();
    const hash = hashOpaqueToken(token);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toHaveLength(32);
    expect(hash.toString('utf8')).not.toContain(token);
    expect(hashOpaqueToken(token)).toEqual(hash);
  });
});
