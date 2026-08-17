// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {normalizeSha256, validateInternalStorageKey} from './service';

describe('stage 6 storage metadata validation', () => {
  it('normalizes a complete SHA-256 value', () => {
    expect(normalizeSha256('A'.repeat(64))).toBe('a'.repeat(64));
    expect(() => normalizeSha256('a'.repeat(63))).toThrow('SHA-256 is invalid');
  });

  it('accepts only internal keys and rejects path traversal or user filenames', () => {
    expect(validateInternalStorageKey('blobs/ab/1234')).toBe('blobs/ab/1234');
    expect(() => validateInternalStorageKey('../secret')).toThrow('Storage key is invalid');
    expect(() => validateInternalStorageKey('blobs/../../secret')).toThrow('Storage key is invalid');
    expect(() => validateInternalStorageKey('meeting notes.pdf')).toThrow('Storage key is invalid');
  });
});
