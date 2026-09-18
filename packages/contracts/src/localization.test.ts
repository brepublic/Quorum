import {describe, expect, it} from 'vitest';
import {
  committeeContentName, formatCommitteeContent, intersectContentLanguages, isContentLanguage,
  motionContentName, templateLanguageAvailability
} from './localization.js';
import type {CountryTemplate} from './stage4.js';

const countries = (names: Array<Record<string, string>>) => ({countries: names.map((value, index) => ({
  id: String(index), stableKey: `country:${index}`, names: value, defaultLanguage: 'en', continent: null,
  sortOrder: index, flag: {type: 'EMOJI' as const, value: '🏳️'}, revision: 1
}))}) satisfies Pick<CountryTemplate, 'countries'>;

describe('committee content language', () => {
  it('accepts only supported languages without silently choosing a default', () => {
    expect(['en', 'zh-CN', 'zh', '', null, undefined].map(isContentLanguage)).toEqual([true, true, false, false, false, false]);
  });
  it('checks every country and member, not defaultLanguage or the template title', () => {
    const result = templateLanguageAvailability(countries([{en: 'China', 'zh-CN': '中国'}, {en: 'Japan', 'zh-CN': '  '}]),
      [{names: {'zh-CN': '观察组织'}}]);
    expect(result.supportedLanguages).toEqual([]);
    expect(result.missing).toEqual([
      {language: 'zh-CN', path: 'countries.1.names.zh-CN'},
      {language: 'en', path: 'members.0.names.en'}
    ]);
  });
  it('computes the supported intersection in system order', () => {
    const template = templateLanguageAvailability(countries([{en: 'China', 'zh-CN': '中国'}]));
    expect(intersectContentLanguages(template.supportedLanguages, ['en'])).toEqual(['en']);
    expect(intersectContentLanguages(['zh-CN'], ['en'])).toEqual([]);
  });
  it('preserves committee names and restricts motion fallback to the committee language', () => {
    expect(committeeContentName({en: 'User original', 'zh-CN': '用户原文'}, 'zh-CN')).toBe('用户原文');
    expect(motionContentName({'zh-CN': '特别动议'}, 'en', 'zh-CN')).toBe('特别动议');
    expect(() => committeeContentName({en: 'English only'}, 'zh-CN')).toThrow('Missing committee translation');
    expect(() => motionContentName({fr: 'Texte'}, 'en', 'zh-CN')).toThrow('Missing committee translation');
  });
  it.each(['en', 'zh-CN'] as const)('uses explicit automatic metadata and preserves lookalike user titles in %s', language => {
    expect(formatCommitteeContent({kind: 'AMENDMENT', ordinal: 9, customTitle: 'New amendment 1'}, language)).toBe('New amendment 1');
    expect(formatCommitteeContent({kind: 'RESOLUTION', sessionOrdinal: 3, ordinal: 8, customTitle: '第1会期'}, language)).toBe('第1会期');
    expect(formatCommitteeContent({kind: 'STRAWPOLL', ordinal: 2, question: 'New strawpoll 1'}, language)).toBe('New strawpoll 1');
  });
  it('formats each resource using its explicit committee language and number', () => {
    expect(formatCommitteeContent({kind: 'GENERAL_SPEAKERS_LIST', customTitle: null}, 'en')).toBe("General Speaker's List");
    expect(formatCommitteeContent({kind: 'GENERAL_SPEAKERS_LIST', customTitle: null}, 'zh-CN')).toBe('主发言名单');
    expect(formatCommitteeContent({kind: 'SESSION', ordinal: 2}, 'en')).toBe('Session 2');
    expect(formatCommitteeContent({kind: 'SESSION', ordinal: 2}, 'zh-CN')).toBe('第2会期');
    expect(formatCommitteeContent({kind: 'RESOLUTION', sessionOrdinal: 2, ordinal: 12, customTitle: null}, 'zh-CN')).toBe('决议草案 2.12');
    expect(formatCommitteeContent({kind: 'AMENDMENT', ordinal: 2, customTitle: null}, 'en')).toBe('New amendment 2');
    expect(formatCommitteeContent({kind: 'STRAWPOLL', ordinal: 2, question: ''}, 'en')).toBe('New strawpoll 2');
    expect(formatCommitteeContent({kind: 'MODERATED_CAUCUS', topic: '用户主题', customTitle: null}, 'en')).toBe('用户主题');
  });
  it.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid ordinal %s', ordinal => {
    expect(() => formatCommitteeContent({kind: 'SESSION', ordinal}, 'en')).toThrow('Invalid resource ordinal');
  });
});
