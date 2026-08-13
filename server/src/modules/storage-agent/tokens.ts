import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_LENGTH = 26;
const DEVICE_CREDENTIAL = /^qsa1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += PAIRING_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += PAIRING_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function normalizePairingCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  const compact = value.trim().toUpperCase().replaceAll('-', '').replace(/^QRM/, '');
  return compact.length === PAIRING_LENGTH && [...compact].every(character => PAIRING_ALPHABET.includes(character))
    ? compact
    : '';
}

export function createPairingCode(): string {
  const compact = encodeCrockford(randomBytes(16));
  return `QRM-${compact.match(/.{1,5}/g)?.join('-') ?? compact}`;
}

export function hashPairingCode(value: unknown): Buffer {
  const normalized = normalizePairingCode(value);
  return createHash('sha256').update(normalized, 'utf8').digest();
}

export function createDeviceCredential(deviceId: string): string {
  return `qsa1.${deviceId}.${randomBytes(32).toString('base64url')}`;
}

export function parseDeviceCredential(value: unknown): {deviceId: string; tokenHash: Buffer} | null {
  if (typeof value !== 'string') return null;
  const match = DEVICE_CREDENTIAL.exec(value);
  return match ? {deviceId: match[1] as string,
    tokenHash: createHash('sha256').update(value, 'utf8').digest()} : null;
}

export function credentialMatches(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
