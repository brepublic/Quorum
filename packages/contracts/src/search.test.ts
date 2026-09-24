import {describe, expect, it} from 'vitest';
import {normalizeSearchTerm, searchOptions} from './search.js';

describe('dropdown search', () => {
  const options = [
    {value: 'a', text: '重庆', searchTerms: ['cq', 'CKG']},
    {value: 'b', text: '中国', searchTerms: ['zg', 'CN']},
    {value: 'c', text: '虚构国家', searchTerms: ['cn']}
  ];

  it('normalizes codes and returns every colliding option without selecting one', () => {
    expect(normalizeSearchTerm('Ｃ－Ｎ')).toBe('cn');
    expect(searchOptions(options, 'CN').map(option => option.value)).toEqual(['b', 'c']);
  });

  it('matches initials, prefixes and name fragments', () => {
    expect(searchOptions(options, 'C-Q').map(option => option.value)).toEqual(['a']);
    expect(searchOptions(options, '中').map(option => option.value)).toEqual(['b']);
    expect(searchOptions(options, '国家').map(option => option.value)).toEqual(['c']);
  });
});
