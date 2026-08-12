// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {validateCommitteeTemplate, validateCountryTemplate, validateFlag, webpDimensions} from './validation';

function webp(width: number, height: number): string {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8); bytes.write('VP8X', 12);
  bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return `data:image/webp;base64,${bytes.toString('base64')}`;
}

describe('stage 4 template validation', () => {
  it('validates WebP bytes and dimensions instead of trusting the data URL label', () => {
    expect(webpDimensions(Buffer.from(webp(256, 160).split(',')[1]!, 'base64'))).toEqual({width: 256, height: 160});
    expect(validateFlag({type: 'IMAGE', value: webp(256, 160)})).toEqual({type: 'IMAGE', value: webp(256, 160)});
    expect(() => validateFlag({type: 'IMAGE', value: webp(257, 160)})).toThrow('dimensions');
    expect(() => validateFlag({type: 'IMAGE', value: 'data:image/webp;base64,bm90LXdlYnA='})).toThrow('WebP');
  });

  it('requires country names to use template-wide language columns', () => {
    expect(() => validateCountryTemplate({names: {en: 'Countries'}, defaultLanguage: 'en', countryLanguages: ['en'],
      countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'en', sortOrder: 1,
        flag: {type: 'STANDARD', value: 'cn'}}]})).toThrow('declared country languages');
  });

  it('keeps voting eligibility, veto, and must-vote independent', () => {
    const template = validateCommitteeTemplate({names: {en: 'Security Council'}, defaultLanguage: 'en',
      countryTemplateKey: 'builtin:default', members: [{stableKey: 'china', names: {en: 'China'}, defaultLanguage: 'en',
        rank: 'VETO', canVote: true, hasVeto: true, mustVote: false, sortOrder: 1,
        flag: {type: 'STANDARD', value: 'cn'}}]});
    expect(template.members[0]).toEqual(expect.objectContaining({canVote: true, hasVeto: true, mustVote: false}));
  });

  it('rejects unknown fields instead of accepting arbitrary template JSON', () => {
    expect(() => validateCommitteeTemplate({names: {en: 'One'}, defaultLanguage: 'en', countryTemplateKey: 'builtin:default',
      members: [], arbitraryMutation: {table: 'users'}})).toThrow('unsupported field');
  });
});
