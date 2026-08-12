import {describe, expect, it} from 'vitest';
import {getRuntimeMode} from './runtime-mode';

describe('runtime mode selection', () => {
  it('keeps Firebase as the default and requires an explicit self-hosted mode', () => {
    expect(getRuntimeMode(undefined)).toBe('firebase');
    expect(getRuntimeMode('firebase')).toBe('firebase');
    expect(getRuntimeMode('self-hosted')).toBe('self-hosted');
    expect(() => getRuntimeMode('mixed')).toThrow('Unsupported');
  });
});
