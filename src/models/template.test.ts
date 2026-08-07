import {describe, expect, it} from 'vitest';
import {Rank} from '../modules/member';
import {templateMembers} from './template';

describe('user templates', () => {
  it('converts Firebase member records to a member list', () => {
    expect(templateMembers({
      name: 'Security Council',
      members: {
        china: {name: 'China', rank: Rank.Veto, present: true, voting: false},
        denmark: {name: 'Denmark', rank: Rank.Standard, present: false, voting: true}
      }
    })).toEqual([
      {name: 'China', rank: Rank.Veto, present: true, voting: false},
      {name: 'Denmark', rank: Rank.Standard, present: false, voting: true}
    ]);
  });

  it('recovers templates whose members have not been initialized', () => {
    expect(templateMembers({name: 'Empty', members: undefined as never})).toEqual([]);
  });
});
