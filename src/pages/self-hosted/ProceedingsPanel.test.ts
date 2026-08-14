import {describe, expect, it} from 'vitest';
import {mapRuleYieldTypes} from './ProceedingsPanel';

describe('self-hosted proceedings rule adapters', () => {
  it('maps rule-package yield vocabulary to the existing command contract', () => {
    expect(mapRuleYieldTypes(['CHAIR', 'DELEGATE', 'QUESTION', 'COMMENT'])).toEqual([
      'CHAIR', 'SEAT', 'QUESTIONS', 'COMMENTS'
    ]);
  });
});
