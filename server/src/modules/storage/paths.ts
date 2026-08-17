import {resolve, sep} from 'node:path';
import {AppError} from '../../http/errors.js';

export function validateInternalStorageKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512
    || !/^[a-z0-9][a-z0-9/_-]*$/.test(value)
    || value.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Storage key is invalid.'});
  }
  return value;
}

export function resolveInternalStoragePath(root: string, key: unknown): string {
  const normalized = validateInternalStorageKey(key);
  const candidate = resolve(root, ...normalized.split('/'));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate === root || !candidate.startsWith(prefix)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Storage key is invalid.'});
  }
  return candidate;
}
