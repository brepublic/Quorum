// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {ARGON2ID_PARAMETERS, hashPassword, verifyPassword} from './password';

describe('Argon2id passwords', () => {
  it('uses the fixed Argon2id parameters and never embeds plaintext', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain(password);
    expect(ARGON2ID_PARAMETERS).toEqual({memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32});
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });
});
