import { beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dropdown } from 'semantic-ui-react';
import { getLanguage, LanguageMenuItem, LanguageProvider, setLanguage, t } from './i18n';

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
    expect(t('Voting rights')).toBe('Voting');
    expect(t('Veto power')).toBe('Veto');
    expect(t('No abstention')).toBe('No abstention');
  });

  it('distinguishes procedural Points from questions asked during a yield or poll', () => {
    expect(t('Points')).toBe('Points');
    expect(t('Question')).toBe('Question');
    expect(t('QUESTIONS')).toBe('Questions');
    expect(t('Yield to questions')).toBe('Yield to Questions');
    expect(t('Yield to the chair')).toBe('Yield to the Chair');
    expect(t('Resolution proposer')).toBe('Sponsors');
    expect(t('Resolution seconder')).toBe('Signatories');
  });

  it.each([
    ["General Speaker's List", "General Speaker's List"],
    ['Create speaker list', "Create Speaker's List"],
    ['Speaker list not found.', "Speaker's List not found."],
    ['Speaker timer', 'Speaker Timer'],
    ['Moderated Caucus timer', 'Moderated Caucus Timer'],
    ['Open Formal Debate', 'Open Formal Debate'],
    ['Introduce Working Paper', 'Introduce Working Paper'],
    ['Introduce Draft Resolution', 'Introduce Draft Resolution'],
    ['Friendly Amendment', 'Friendly Amendment'],
    ['Unfriendly Amendment', 'Unfriendly Amendment'],
    ['Simple majority', 'Simple Majority'],
    ['Two-thirds majority', 'Two-Thirds Majority'],
    ['PRESENT_AND_VOTING', 'Present and Voting'],
    ['Strawpolls', 'Straw Polls'],
    ['Propose Strawpoll', 'Propose Straw Poll'],
    ['Simple (50%) majority required', 'Simple Majority required (more than 50%)']
  ])('uses canonical English terminology for %s', (key, expected) => {
    expect(t(key)).toBe(expected);
  });

  it('preserves interpolated user text and the Chinese terminology', () => {
    expect(t('New Strawpoll {count}', {count: 2})).toBe('New Straw Poll 2');
    expect(t('The {item} you were looking for (ID: {id}) could not be found. It may have been deleted, or the URL you navigated to was incorrect.',
      {item: 'my lowercase strawpoll', id: 'draft resolution'})).toContain('my lowercase strawpoll you were looking for (ID: draft resolution)');
    setLanguage('zh-CN');
    expect(t('Points')).toBe('问题');
    expect(t('Yield to questions')).toBe('让渡给问题');
    expect(t('Resolution proposer')).toBe('起草国');
    expect(t('Resolution seconder')).toBe('附议国');
  });

  it('switches to Simplified Chinese and interpolates values', () => {
    setLanguage('zh-CN');

    expect(getLanguage()).toBe('zh-CN');
    expect(t('{count} votes', { count: 12 })).toBe('12 票');
    expect(window.localStorage.getItem('muncoordinated-language')).toBe('zh-CN');
  });

  it('uses the requested Mainland China MUN terminology', () => {
    setLanguage('zh-CN');

    expect(t('Unmoderated Caucus')).toBe('自由磋商');
    expect(t('Open Moderated Caucus')).toBe('开启有主持核心磋商');
    expect(t('Introduce Draft Resolution')).toBe('展示决议草案');
    expect(t('Introduce Working Paper')).toBe('展示工作文件');
    expect(t('Veto')).toBe('一票否决');
    expect(t('Roll Call')).toBe('点名');
    expect(t('Absent')).toBe('缺席');
    expect(t('Voting delegation')).toBe('投票代表团');
    expect(t('Now voting')).toBe('当前表决国家');
    expect(t('Voting rights')).toBe('表决权');
    expect(t('No abstention')).toBe('不得弃权');
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
