import argon2 from 'argon2';
import {randomBytes} from 'node:crypto';

export const ARGON2ID_PARAMETERS = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32
});

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    ...ARGON2ID_PARAMETERS
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function createTemporaryPassword(): string {
  return `${randomBytes(15).toString('base64url')}Aa1!`;
}
