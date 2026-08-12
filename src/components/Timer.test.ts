import {describe, expect, it} from 'vitest';
import {hhmmss} from './Timer';

describe('timer display', () => {
  it('never formats an overdue timer as a negative value', () => {
    expect(hhmmss(-1043)).toBe('0:00');
    expect(hhmmss(0)).toBe('0:00');
  });
});
