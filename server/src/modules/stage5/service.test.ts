// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {canYieldSpeech, remainingTimerMs, timerState} from './service';

describe('server-authoritative timers', () => {
  it('derives a running timer only from server time and persisted start state', () => {
    const row = {running: true, started_at: new Date('2026-08-13T00:00:00.000Z'), remaining_at_start_ms: 60_000};
    expect(remainingTimerMs(row, new Date('2026-08-13T00:00:15.250Z'))).toBe(44_750);
    expect(remainingTimerMs(row, new Date('2026-08-13T00:02:00.000Z'))).toBe(0);
  });

  it('allows only paused original time to be yielded once', () => {
    expect(canYieldSpeech({kind: 'ORIGINAL', can_yield: true, status: 'PAUSED'}, 1_001, false)).toBe(true);
    expect(canYieldSpeech({kind: 'INHERITED', can_yield: false, status: 'PAUSED'}, 30_000, false)).toBe(false);
    expect(canYieldSpeech({kind: 'ORIGINAL', can_yield: true, status: 'RUNNING'}, 30_000, true)).toBe(false);
  });

  it('serializes the server observation time and never exposes negative remaining time', () => {
    const state = timerState({id: 'timer', committee_id: 'committee', owner_type: 'COMMITTEE', owner_id: 'owner',
      running: true, started_at: new Date('2026-08-13T00:00:00.000Z'), remaining_at_start_ms: 1_000,
      revision: 3, expired_at: null}, new Date('2026-08-13T00:00:02.000Z'));
    expect(state).toEqual(expect.objectContaining({running: false, remainingMs: 0, revision: 3,
      serverTime: '2026-08-13T00:00:02.000Z'}));
  });
});
