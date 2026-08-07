import {describe, expect, it} from 'vitest';
import {Rank} from '../modules/member';
import {templateDefaultLanguage, templateDisplayName, templateMembers} from './template';

describe('user templates', () => {
  it('converts Firebase member records to a member list', () => {
    expect(templateMembers({
      name: 'Security Council',
      members: {
        china: {name: 'China', rank: Rank.Veto, present: true, voting: false},
        denmark: {name: 'Denmark', rank: Rank.Standard, present: false, voting: true}
      }
    })).toEqual([
      {name: 'China', rank: Rank.Veto, present: true, voting: false},
      {name: 'Denmark', rank: Rank.Standard, present: false, voting: true}
    ]);
  });

  it('recovers templates whose members have not been initialized', () => {
    expect(templateMembers({name: 'Empty', members: undefined as never})).toEqual([]);
  });

  it('displays the name for the requested language', () => {
    const template = {
      name: 'Security Council',
      defaultLanguage: 'en' as const,
      names: {
        en: 'Security Council',
        'zh-CN': '安理会'
      },
      members: {}
    };

    expect(templateDisplayName(template, 'zh-CN')).toBe('安理会');
    expect(templateDisplayName(template, 'en')).toBe('Security Council');
  });

  it('falls back to the default language and remains compatible with legacy templates', () => {
    expect(templateDisplayName({
      name: 'Conseil',
      defaultLanguage: 'en',
      names: {en: 'Council'},
      members: {}
    }, 'zh-CN')).toBe('Council');

    expect(templateDisplayName({name: 'Legacy template', members: {}}, 'zh-CN'))
      .toBe('Legacy template');
  });

  it('uses another available language when the default name is unavailable', () => {
    const incompleteTemplate = {
      name: '',
      defaultLanguage: 'en' as const,
      names: {'zh-CN': '唯一名称'},
      members: {}
    };

    expect(templateDisplayName(incompleteTemplate, 'en')).toBe('唯一名称');
    expect(templateDefaultLanguage(incompleteTemplate, 'zh-CN')).toBe('en');
  });
});
