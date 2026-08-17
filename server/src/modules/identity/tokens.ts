import {createHash, randomBytes} from 'node:crypto';

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function hashSource(value: string | undefined): Buffer | null {
  return value ? createHash('sha256').update(value, 'utf8').digest() : null;
}
