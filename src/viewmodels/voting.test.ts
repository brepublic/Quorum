import {describe, expect, it} from 'vitest';
import {getAutomaticVoteResult, nextUnvotedMemberID} from './voting';

describe('nextUnvotedMemberID', () => {
  it('advances after the current delegation and wraps to the first unvoted delegation', () => {
    expect(nextUnvotedMemberID(['a', 'b', 'c'], 'a', {a: 'For'})).toBe('b');
    expect(nextUnvotedMemberID(['a', 'b', 'c'], 'c', {a: 'For', c: 'Against'})).toBe('b');
  });

  it('returns undefined after every delegation has voted', () => {
    expect(nextUnvotedMemberID(
      ['a', 'b'],
      'a',
      {a: 'For', b: 'Against'}
    )).toBeUndefined();
  });
});

describe('getAutomaticVoteResult', () => {
  it('passes as soon as the required threshold is reached', () => {
    expect(getAutomaticVoteResult({
      eligibleVoters: 10,
      votesFor: 7,
      votesCast: 8,
      threshold: 7
    })).toBe('passed');
  });

  it('fails as soon as the remaining votes cannot reach the threshold', () => {
    expect(getAutomaticVoteResult({
      eligibleVoters: 10,
      votesFor: 4,
      votesCast: 8,
      threshold: 7
    })).toBe('failed');
  });

  it('does not announce a result while either outcome remains possible', () => {
    expect(getAutomaticVoteResult({
      eligibleVoters: 10,
      votesFor: 4,
      votesCast: 6,
      threshold: 7
    })).toBeUndefined();
  });

  it('does not report a passed result when a veto applies', () => {
    expect(getAutomaticVoteResult({
      eligibleVoters: 10,
      votesFor: 10,
      votesCast: 10,
      threshold: 7,
      vetoed: true
    })).toBeUndefined();
  });

  it('fails when there are no eligible voters', () => {
    expect(getAutomaticVoteResult({
      eligibleVoters: 0,
      votesFor: 0,
      votesCast: 0,
      threshold: 0
    })).toBe('failed');
  });
});
