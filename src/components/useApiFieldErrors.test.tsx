import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, it} from 'vitest';
import {Form} from 'semantic-ui-react';
import {LanguageProvider, setLanguage} from '../i18n';
import {useApiFieldErrors} from './useApiFieldErrors';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

describe('structured field feedback', () => {
  it('opens and focuses the invalid field and translates feedback without replacing its draft or focus', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const failure = {localization: {fieldErrors: [{field: 'email', reason: 'INVALID_EMAIL'}]}};
    function Editor({error}: {error?: unknown}) {
      const field = useApiFieldErrors(error);
      return <details><summary>Account</summary><Form><Form.Input {...field('email')} defaultValue="unfinished" />
        <input aria-label="Other" /></Form></details>;
    }
    try {
      act(() => setLanguage('en'));
      await act(async () => root.render(<LanguageProvider><Editor /></LanguageProvider>));
      const input = host.querySelector('input')!;
      await act(async () => root.render(<LanguageProvider><Editor error={failure} /></LanguageProvider>));
      expect(host.querySelector('details')?.open).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(host.textContent).toContain('Enter a valid email address.');
      const other = host.querySelector<HTMLInputElement>('[aria-label="Other"]')!; other.focus();
      act(() => setLanguage('zh-CN'));
      expect(host.querySelector('input')).toBe(input);
      expect(input.value).toBe('unfinished');
      expect(document.activeElement).toBe(other);
      expect(host.textContent).toContain('请输入有效的邮箱地址。');
    } finally {act(() => root.unmount()); host.remove(); act(() => setLanguage('en'));}
  });
});
