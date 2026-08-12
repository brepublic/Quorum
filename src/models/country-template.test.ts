import {describe, expect, it} from 'vitest';
import {
  cloneCountryTemplate,
  committeeTemplatesUsingCountryTemplate,
  countryDisplayName,
  countryNameLanguages,
  countryTemplateDisplayName,
  DEFAULT_COUNTRY_TEMPLATE,
  fitImageSize,
  isoCodeToEmoji
} from './country-template';

describe('country templates', () => {
  it('exposes the current built-in countries as a localized default template', () => {
    expect(countryTemplateDisplayName(DEFAULT_COUNTRY_TEMPLATE, 'zh-CN')).toBe('默认国家');
    expect(countryDisplayName(DEFAULT_COUNTRY_TEMPLATE.countries.cn, 'zh-CN')).toBe('中国');
    expect(DEFAULT_COUNTRY_TEMPLATE.countries.cn.continent).toBe('Asia');
    expect(DEFAULT_COUNTRY_TEMPLATE.countries.us.flag).toEqual({type: 'emoji', value: '🇺🇸'});
    expect(Object.values(DEFAULT_COUNTRY_TEMPLATE.countries).every(country => !!country.continent)).toBe(true);
  });

  it('discovers country name languages and falls back for legacy data', () => {
    expect(countryNameLanguages({
      name: 'Legacy',
      countries: {one: {name: 'One', names: {'zh-CN': '一'}}}
    }, 'en')).toEqual(['zh-CN']);
    expect(countryDisplayName({name: 'One'}, 'zh-CN')).toBe('One');
  });

  it('clones the complete template under a localized copy name', () => {
    const clone = cloneCountryTemplate(DEFAULT_COUNTRY_TEMPLATE, 'zh-CN');
    expect(clone.name).toBe('默认国家 (副本)');
    expect(clone.countries).not.toBe(DEFAULT_COUNTRY_TEMPLATE.countries);
    expect(Object.keys(clone.countries)).toHaveLength(Object.keys(DEFAULT_COUNTRY_TEMPLATE.countries).length);
  });

  it('creates flag emoji and scales images without upscaling', () => {
    expect(isoCodeToEmoji('cn')).toBe('🇨🇳');
    expect(isoCodeToEmoji('custom')).toBe('🏳️');
    expect(fitImageSize(1000, 500)).toEqual({width: 256, height: 128});
    expect(fitImageSize(64, 48)).toEqual({width: 64, height: 48});
  });

  it('finds every committee template that prevents deletion of a country template', () => {
    expect(committeeTemplatesUsingCountryTemplate({
      one: {name: 'One', countryTemplateKey: 'custom:countries-a'},
      two: {name: 'Two', countryTemplateKey: 'custom:countries-a'},
      other: {name: 'Other', countryTemplateKey: 'custom:countries-b'},
      legacy: {name: 'Legacy'}
    }, 'custom:countries-a')).toEqual([
      {id: 'one', name: 'One'},
      {id: 'two', name: 'Two'}
    ]);
  });
});
