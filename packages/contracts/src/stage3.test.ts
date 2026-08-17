// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {freezeRuleEvaluation} from './stage3';

describe('stage 3 shared contracts', () => {
  it('freezes a ballot-compatible rule evaluation independently from future activation', () => {
    const definition = {schemaVersion: 1, key: 'test:one', ballots: {threshold: 5}};
    const frozen = freezeRuleEvaluation({packageVersionId: 'version-one', definition,
      facts: {'ballot.eligibleSeatCount': 9}, resolvedValues: {threshold: 5}, frozenAt: '2026-08-12T00:00:00.000Z'});
    definition.ballots.threshold = 7;
    expect(frozen.definition).toEqual(expect.objectContaining({ballots: {threshold: 5}}));
    expect(frozen.packageVersionId).toBe('version-one');
  });
});
