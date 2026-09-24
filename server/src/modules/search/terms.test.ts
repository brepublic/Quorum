import {describe, expect, it} from 'vitest';
import {generatedTerms} from './terms.js';

describe('generated search terms', () => {
  it('uses phrase-aware pinyin initials, English initials and the existing code', () => {
    expect(generatedTerms({'zh-CN': '重庆', en: 'United States of America'}, 'US'))
      .toEqual(expect.arrayContaining(['重庆', 'cq', 'unitedstatesofamerica', 'usa', 'us']));
  });

  it('does not infer a code from a custom flag or key', () => {
    expect(generatedTerms({'zh-CN': '星河联邦', en: 'Xinghe Federation'}))
      .toEqual(expect.arrayContaining(['星河联邦', 'xhlb', 'xinghefederation', 'xf']));
  });
});
