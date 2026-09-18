import {describe, expect, it} from 'vitest';
import {ruleLanguageAvailability, type RulePackageDefinition} from './index.js';
const definition = (): RulePackageDefinition => ({schemaVersion: 1, key: 'test:localized',
  metadata: {defaultLanguage: 'en', names: {en: 'Rules', 'zh-CN': '规则'}},
  meeting: {}, attendance: {}, phases: [], speakerLists: [], points: [], motions: [], ballots: {}, documents: {}, terminology: {}});

describe('rule language availability', () => {
  it('checks actual motion and phase names despite bilingual package metadata', () => {
    const rules = definition();
    rules.phases = [{id: 'debate', names: {en: 'Debate'}}];
    rules.motions = [{id: 'custom', names: {en: 'Custom'}}];
    expect(ruleLanguageAvailability(rules)).toEqual({supportedLanguages: ['en'], missing: [
      {language: 'zh-CN', path: 'phases.0.names.zh-CN'}, {language: 'zh-CN', path: 'motions.0.names.zh-CN'}]});
  });
  it('reports unnamed custom content rather than assuming its id is an English label', () => {
    const rules = definition(); rules.points = [{id: 'custom'}];
    expect(ruleLanguageAvailability(rules).supportedLanguages).toEqual([]);
  });
  it('checks parameter labels, descriptions and terminology', () => {
    const rules = definition(); rules.motions = [{id: 'custom', names: {en: 'Custom', 'zh-CN': '自定义'},
      parameters: [{id: 'duration', label: {en: 'Duration'}}]}];
    rules.terminology = {delegate: {en: 'Delegate'}};
    expect(ruleLanguageAvailability(rules).missing).toEqual([
      {language: 'zh-CN', path: 'motions.0.parameters.0.label.zh-CN'},
      {language: 'zh-CN', path: 'terminology.delegate.zh-CN'}]);
  });
  it('does not treat machine codes or numeric rules as display names', () => {
    const rules = definition(); rules.attendance = {responses: ['PRESENT', 'ABSENT'], minimum: 3};
    expect(ruleLanguageAvailability(rules)).toEqual({supportedLanguages: ['zh-CN', 'en'], missing: []});
  });
});
