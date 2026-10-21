import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, it} from 'vitest';
import {apiErrorText, setLanguage} from '../i18n';
import {SelfHostedApiError} from '../services/self-hosted-api';
import {StorageErrorMessage} from './StorageErrorMessage';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

describe('cache disk space feedback', () => {
  it.each(['zh-CN', 'en'] as const)('separates a useful summary from measured diagnostics in %s', async language => {
    setLanguage(language);
    const error = new SelfHostedApiError(503, 'SERVICE_NOT_READY', '/private/server/path', 'req-reserve', {
      totalBytes: 100 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, writeBytes: 1024 ** 2,
      minimumFreeBytes: 20 * 1024 ** 3, storageMinFreeBytes: 10 * 1024 ** 3,
      storageMinFreePercent: 20,
      privatePath: '/private/cache/path'
    }, {reason: 'STORAGE_RESERVE_REQUIRED'});
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      await act(async () => root.render(<StorageErrorMessage error={error} text={apiErrorText(error)} />));
      expect(host.querySelector('p')?.textContent).toContain(language === 'zh-CN' ? '请联系服务器管理员' : 'Contact the server administrator');
      const details = host.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(details.textContent).toContain('STORAGE_RESERVE_REQUIRED');
      expect(details.textContent).toContain('req-reserve');
      expect(details.textContent).toContain('20 GiB');
      expect(details.textContent).toContain('12,885,950,464 B');
      expect(details.textContent).not.toContain('QUORUM_STORAGE_HARD_MIN_FREE_BYTES');
      expect(host.textContent).not.toContain('/private');
      await act(async () => details.querySelector('summary')!.click());
      expect(details.open).toBe(true);
    } finally {await act(async () => root.unmount()); setLanguage('zh-CN');}
  });

  it('supports older servers and rejects malformed diagnostics', async () => {
    setLanguage('en');
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      for (const details of [undefined, {availableBytes: '<secret>', totalBytes: Infinity,
        writeBytes: -1, minimumFreeBytes: NaN, storageMinFreePercent: 101}]) {
        const error = {reason: 'STORAGE_RESERVE_REQUIRED', requestId: '/private/id', details};
        await act(async () => root.render(<StorageErrorMessage error={error} text={apiErrorText(error)} />));
        expect(host.textContent).toContain('STORAGE_RESERVE_REQUIRED');
        expect(host.textContent).toContain('—');
        expect(host.textContent).not.toMatch(/secret|private|NaN|Infinity|101%/);
      }
    } finally {await act(async () => root.unmount()); setLanguage('zh-CN');}
  });
});
