// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {resolveInternalStoragePath, validateInternalStorageKey} from './paths';

describe('internal storage paths', () => {
  it('accepts only normalized relative server keys', () => {
    expect(validateInternalStorageKey('uploads/ab/0123')).toBe('uploads/ab/0123');
    for (const value of ['/absolute', '../secret', 'uploads/../../secret', 'uploads/./secret',
      'uploads/name.pdf', 'uploads\\secret']) {
      expect(() => validateInternalStorageKey(value)).toThrow('Storage key is invalid');
    }
  });

  it('resolves below the configured root without consulting a user filename', () => {
    expect(resolveInternalStoragePath('/srv/quorum/staging', 'uploads/ab/0123'))
      .toBe('/srv/quorum/staging/uploads/ab/0123');
    expect(resolveInternalStoragePath('/srv/quorum/staging', 'uploads/ab/0123')).not.toContain('meeting notes.pdf');
  });
});
