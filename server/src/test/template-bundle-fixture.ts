import type {TemplateBundle} from '@quorum/contracts';

// A decodable 24 × 16 WebP, not just a RIFF header.
export const templateFlagImage = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvF8ADAAdQu2IUsf+BiOh/AAA=';
export const templateBundleFixture = {
  format: 'quorum-template', version: 1, kind: 'committee',
  countryTemplate: {
    names: {en: 'Future countries', 'zh-CN': '未来峰会国家'}, defaultLanguage: 'en', countryLanguages: ['en', 'zh-CN'],
    countries: [
      {stableKey: 'fr', names: {en: 'France', 'zh-CN': '法国'}, defaultLanguage: 'en', continent: 'Europe', sortOrder: 0,
        flag: {type: 'STANDARD', value: 'fr'}, searchCodes: ['FRA']},
      {stableKey: 'hailan', names: {en: 'Hailan Federation', 'zh-CN': '海岚联邦'}, defaultLanguage: 'en', continent: 'Asia', sortOrder: 1,
        flag: {type: 'IMAGE', value: templateFlagImage}, searchCodes: ['HL', '海岚']},
      {stableKey: 'green', names: {en: 'Green Organization', 'zh-CN': '环保组织'}, defaultLanguage: 'en', continent: null, sortOrder: 2,
        flag: {type: 'EMOJI', value: '🌱'}, searchCodes: []},
      {stableKey: 'extra', names: {en: 'Extra delegation', 'zh-CN': '备用代表团'}, defaultLanguage: 'en', continent: null, sortOrder: 3,
        flag: {type: 'EMOJI', value: '🏳️‍🌈'}, searchCodes: ['EX']}
    ]
  },
  committeeTemplate: {
    names: {en: 'Future summit', 'zh-CN': '未来峰会'}, defaultLanguage: 'en', countryTemplateKey: 'bundled',
    members: [
      {stableKey: 'fr', names: {en: 'France', 'zh-CN': '法国'}, defaultLanguage: 'en', rank: 'STANDARD',
        canVote: true, canProceduralVote: true, hasVeto: true, mustVote: false, sortOrder: 0, flag: {type: 'STANDARD', value: 'fr'}},
      {stableKey: 'hailan', names: {en: 'Hailan Federation', 'zh-CN': '海岚联邦'}, defaultLanguage: 'en', rank: 'STANDARD',
        canVote: true, canProceduralVote: true, hasVeto: false, mustVote: true, sortOrder: 1, flag: {type: 'IMAGE', value: templateFlagImage}},
      {stableKey: 'green', names: {en: 'Green Organization', 'zh-CN': '环保组织'}, defaultLanguage: 'en', rank: 'MEDIA',
        canVote: false, canProceduralVote: false, hasVeto: false, mustVote: false, sortOrder: 2, flag: {type: 'EMOJI', value: '🌳'}}
    ]
  }
} satisfies TemplateBundle;
