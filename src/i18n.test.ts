import { beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dropdown } from 'semantic-ui-react';
import { getLanguage, LanguageMenuItem, LanguageProvider, localizeGeneratedName, setLanguage, t } from './i18n';

function EmptySearchDropdown() {
  return React.createElement(Dropdown, { open: true, options: [], search: true });
}

describe('i18n', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLanguage('en');
  });

  it('uses English keys as the default copy', () => {
    expect(t('Motions')).toBe('Motions');
    expect(t('Motion action: Open')).toBe('Open');
  });

  it('switches to Simplified Chinese and interpolates values', () => {
    setLanguage('zh-CN');

    expect(getLanguage()).toBe('zh-CN');
    expect(t('{count} votes', { count: 12 })).toBe('12 票');
    expect(window.localStorage.getItem('muncoordinated-language')).toBe('zh-CN');
  });

  it('uses the requested Mainland China MUN terminology', () => {
    setLanguage('zh-CN');

    expect(t('Unmoderated caucus')).toBe('自由磋商');
    expect(t('Open moderated caucus')).toBe('开启有主持核心磋商');
    expect(t('Introduce draft resolution')).toBe('展示决议草案');
    expect(t('Introduce working paper')).toBe('展示工作文件');
    expect(t('Veto')).toBe('一票否决');
    expect(t('Roll call')).toBe('点名');
    expect(t('Absent')).toBe('缺席');
    expect(t('Voting delegation')).toBe('投票代表团');
    expect(t('Now voting')).toBe('当前表决国家');
    expect(localizeGeneratedName('New draft resolution 12')).toBe('新决议草案12');
    expect(localizeGeneratedName('New strawpoll 2')).toBe('新意向性投票2');
  });

  it('falls back to the English key when a Chinese entry is unavailable', () => {
    setLanguage('zh-CN');
    expect(t('Committee-specific user content')).toBe('Committee-specific user content');
  });

  it('renders the language control inside a menu item', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(React.createElement(LanguageMenuItem));

    const switcher = container.querySelector('.language-switcher');
    expect(switcher?.parentElement?.classList.contains('item')).toBe(true);
    expect((switcher as HTMLElement).style.position).toBe('');

  });

  it('localizes Semantic UI dropdown fallback copy centrally', () => {
    setLanguage('zh-CN');
    const markup = renderToStaticMarkup(
      React.createElement(
        LanguageProvider,
        null,
        React.createElement(EmptySearchDropdown)
      )
    );

    expect(markup).toContain('未找到结果。');
  });
});
