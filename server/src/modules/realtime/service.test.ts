// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {selectEventCursor} from './service';

describe('SSE event cursor selection', () => {
  it('uses the newer valid query or Last-Event-ID cursor', () => {
    expect(selectEventCursor({after: '12', lastEventId: '15', latestSequence: 20, retainedFromSequence: 10})).toBe(15);
    expect(selectEventCursor({after: '18', lastEventId: '999', latestSequence: 20, retainedFromSequence: 10})).toBe(18);
  });

  it('returns a stable expiry error when no supplied cursor is retained', () => {
    expect(() => selectEventCursor({after: '7', lastEventId: '8', latestSequence: 20, retainedFromSequence: 10}))
      .toThrow(expect.objectContaining({code: 'CURSOR_EXPIRED', status: 410}));
  });

  it('starts at the current sequence when no cursor is supplied', () => {
    expect(selectEventCursor({latestSequence: 20, retainedFromSequence: 10})).toBe(20);
  });
});
