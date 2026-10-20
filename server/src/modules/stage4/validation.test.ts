// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {validateCommitteeTemplate, validateCountryTemplate, validateFlag, webpDimensions, validateTemplateBundle} from './validation';
import {templateBundleFixture} from '../../test/template-bundle-fixture';

function webp(width: number, height: number): string {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8); bytes.write('VP8X', 12);
  bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return `data:image/webp;base64,${bytes.toString('base64')}`;
}

describe('stage 4 template validation', () => {
  it('accepts portable templates without losing flags, translations or permissions', () => {
    expect(validateTemplateBundle(templateBundleFixture)).toEqual(templateBundleFixture);
    expect(validateTemplateBundle({format: 'quorum-template', version: 1, kind: 'country',
      countryTemplate: templateBundleFixture.countryTemplate}).countryTemplate).toEqual(templateBundleFixture.countryTemplate);
  });

  it('rejects foreign references, missing dependencies, unsupported versions and untrusted image URLs', () => {
    for (const patch of [{format: 'other'}, {version: 2}, {countryTemplate: null}, {ownerUserId: 'other'}]) {
      expect(() => validateTemplateBundle({...templateBundleFixture, ...patch})).toThrow();
    }
    for (const key of ['custom:10000000-0000-4000-8000-000000000001', 'builtin:default']) {
      expect(() => validateTemplateBundle({...templateBundleFixture,
        committeeTemplate: {...templateBundleFixture.committeeTemplate, countryTemplateKey: key}})).toThrow();
    }
    for (const value of ['https://source.example/flag.webp', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/webp;base64,YWJj']) {
      const bundle = structuredClone(templateBundleFixture);
      bundle.countryTemplate.countries[1]!.flag.value = value;
      expect(() => validateTemplateBundle(bundle)).toThrow();
    }
  });
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

  it('allows an empty country template so countries can be added after creation', () => {
    expect(validateCountryTemplate({names: {en: 'Countries'}, defaultLanguage: 'en', countryLanguages: ['en'],
      countries: []}).countries).toEqual([]);
  });

  it('keeps voting eligibility, veto, and must-vote independent', () => {
    const template = validateCommitteeTemplate({names: {en: 'Security Council'}, defaultLanguage: 'en',
      countryTemplateKey: 'builtin:default', members: [{stableKey: 'china', names: {en: 'China'}, defaultLanguage: 'en',
        rank: 'STANDARD', canVote: true, canProceduralVote: true, hasVeto: true, mustVote: false, sortOrder: 1,
        flag: {type: 'STANDARD', value: 'cn'}}]});
    expect(template.members[0]).toEqual(expect.objectContaining({canVote: true, canProceduralVote: true, hasVeto: true, mustVote: false}));
  });

  it.each(['STANDARD', 'NGO', 'OBSERVER', 'MEDIA'])('allows the same independent capabilities for %s and rejects invalid combinations', rank => {
    const input = {names: {en: 'Capabilities'}, defaultLanguage: 'en', countryTemplateKey: 'builtin:default',
      members: [{stableKey: 'one', names: {en: 'One'}, defaultLanguage: 'en', rank,
        canVote: true, canProceduralVote: true, hasVeto: true, mustVote: true, sortOrder: 0, flag: {type: 'EMOJI', value: '🏳️'}}]};
    expect(validateCommitteeTemplate(input).members[0]).toMatchObject({rank, canVote: true, canProceduralVote: true, hasVeto: true, mustVote: true});
    for (const canProceduralVote of [true, false]) expect(validateCommitteeTemplate({...input, members: [{...input.members[0],
      canVote: false, canProceduralVote, hasVeto: false, mustVote: false}]}).members[0]).toMatchObject({canVote: false, canProceduralVote});
    for (const patch of [{canVote: false, canProceduralVote: true}, {canVote: false, canProceduralVote: true, hasVeto: false}, {canProceduralVote: false}, {rank: 'VETO'}]) {
      expect(() => validateCommitteeTemplate({...input, members: [{...input.members[0], ...patch}]})).toThrow();
    }
  });

  it('rejects unknown fields instead of accepting arbitrary template JSON', () => {
    expect(() => validateCommitteeTemplate({names: {en: 'One'}, defaultLanguage: 'en', countryTemplateKey: 'builtin:default',
      members: [], arbitraryMutation: {table: 'users'}})).toThrow('unsupported field');
  });
});
