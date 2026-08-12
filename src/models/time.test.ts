import {describe, expect, it} from 'vitest';
import {advanceTimer, TimerData} from './time';

const runningTimer = (remaining: number): TimerData => ({
  elapsed: 10,
  remaining,
  ticking: 100
});

describe('timer countdown', () => {
  it('stops exactly at zero', () => {
    expect(advanceTimer(runningTimer(1), 1)).toEqual({
      elapsed: 11,
      remaining: 0,
      ticking: false
    });
  });

  it('clamps an overdue or legacy negative timer to zero', () => {
    expect(advanceTimer(runningTimer(5), 20)).toEqual({
      elapsed: 15,
      remaining: 0,
      ticking: false
    });
    expect(advanceTimer(runningTimer(-10), 1)).toEqual({
      elapsed: 10,
      remaining: 0,
      ticking: false
    });
  });
});
