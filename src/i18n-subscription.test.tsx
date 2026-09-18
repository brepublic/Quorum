import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Dropdown} from 'semantic-ui-react';
import {LanguageProvider, getLanguage, setLanguage, t, useLanguage} from './i18n';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {setLanguage('en'); vi.useRealTimers();});

describe('language subscriptions', () => {
  it('updates copy and dropdown defaults without losing draft, focus, selection, connection or timer', () => {
    setLanguage('en'); vi.useFakeTimers();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); const connect = vi.fn(); const disconnect = vi.fn();
    function Screen() {
      useLanguage();
      const [draft, setDraft] = React.useState('unsaved draft');
      const [ticks, setTicks] = React.useState(0);
      React.useEffect(() => {
        connect(); const timer = window.setInterval(() => setTicks(value => value + 1), 1000);
        return () => {disconnect(); window.clearInterval(timer);};
      }, []);
      return <><button>{t('Logout')}</button><input value={draft} onChange={event => setDraft(event.target.value)} />
        <output>{ticks}</output><Dropdown open search options={[]} /></>;
    }
    try {
      act(() => root.render(<LanguageProvider><Screen /></LanguageProvider>));
      const input = container.querySelector('input')!;
      act(() => {input.focus(); input.setSelectionRange(2, 5);});
      act(() => vi.advanceTimersByTime(1000));
      expect(container.querySelector('output')?.textContent).toBe('1');
      act(() => setLanguage('zh-CN'));
      expect(container.querySelector('button')?.textContent).toBe('退出登录');
      expect(container.querySelector('input')).toBe(input);
      expect(input.value).toBe('unsaved draft');
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
      expect(container.textContent).toContain('未找到结果。');
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(connect).toHaveBeenCalledTimes(1); expect(disconnect).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1000));
      expect(container.querySelector('output')?.textContent).toBe('2');
      act(() => setLanguage('en'));
      expect(getLanguage()).toBe('en'); expect(container.querySelector('input')).toBe(input);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {act(() => root.unmount()); container.remove();}
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
