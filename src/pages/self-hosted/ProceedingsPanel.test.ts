import {describe, expect, it} from 'vitest';
import {mapRuleYieldTypes, questionContributionTemplate} from './ProceedingsPanel';

describe('self-hosted proceedings rule adapters', () => {
  it('maps rule-package yield vocabulary to the existing command contract', () => {
    expect(mapRuleYieldTypes(['CHAIR', 'DELEGATE', 'QUESTION', 'COMMENT'])).toEqual([
      'CHAIR', 'SEAT', 'QUESTIONS', 'COMMENTS'
    ]);
  });

  it('starts a question interaction with question and answer prompts', () => {
    expect(questionContributionTemplate).toBe('Q:\n\nA:');
  });
});
