// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {localizedDisplayName} from './stage4';

describe('stage 4 shared contracts', () => {
  it('falls back from the requested language to the default and then another non-empty name', () => {
    expect(localizedDisplayName({'zh-CN': '中国', en: 'China'}, 'en', 'zh-CN')).toBe('中国');
    expect(localizedDisplayName({en: 'China'}, 'en', 'zh-CN')).toBe('China');
    expect(localizedDisplayName({fr: '', es: 'China'}, 'en', 'zh-CN')).toBe('China');
  });

  it('does not confuse must-vote with voting eligibility or veto power', () => {
    const seat = {
      rank: 'VETO' as const,
      canVote: true,
      hasVeto: true,
      mustVote: false
    };
    expect(seat.canVote).toBe(true);
    expect(seat.hasVeto).toBe(true);
    expect(seat.mustVote).toBe(false);
  });
});
