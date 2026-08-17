// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {
  createDeviceCredential,
  createPairingCode,
  credentialMatches,
  hashPairingCode,
  normalizePairingCode,
  parseDeviceCredential
} from './tokens';

describe('storage Agent one-time secrets', () => {
  it('creates a human-enterable 128-bit pairing code with one canonical hash', () => {
    const code = createPairingCode();
    expect(code).toMatch(/^QRM-[0-9A-HJKMNP-TV-Z-]+$/);
    const compact = normalizePairingCode(code);
    expect(compact).toHaveLength(26);
    expect(hashPairingCode(code)).toEqual(hashPairingCode(compact.toLowerCase()));
    expect(normalizePairingCode('QRM-invalid')).toBe('');
  });

  it('binds a high-entropy credential to its server device ID', () => {
    const deviceId = '10000000-0000-4000-8000-000000000001';
    const credential = createDeviceCredential(deviceId);
    const parsed = parseDeviceCredential(credential);
    expect(credential).toMatch(/^qsa1\./);
    expect(parsed?.deviceId).toBe(deviceId);
    expect(parsed?.tokenHash).toHaveLength(32);
    expect(credentialMatches(parsed?.tokenHash as Buffer, parsed?.tokenHash as Buffer)).toBe(true);
    expect(parseDeviceCredential(`${credential}x`)).toBeNull();
  });
});
