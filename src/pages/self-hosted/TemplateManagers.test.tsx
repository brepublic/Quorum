import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CountryTemplate} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {getLanguage} from '../../i18n';
import {CountryTemplateManager} from './TemplateManagers';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const builtin: CountryTemplate = {id: 'builtin:default', key: 'builtin:default', builtin: true,
  names: {en: 'Default countries', 'zh-CN': '默认国家'}, defaultLanguage: 'zh-CN', countryLanguages: ['zh-CN', 'en'],
  countries: [{id: 'builtin:cn', stableKey: 'cn', names: {en: 'China', 'zh-CN': '中国'}, defaultLanguage: 'zh-CN',
    continent: 'Asia', sortOrder: 0, flag: {type: 'STANDARD', value: 'cn'}, revision: 1}],
  revision: 1, createdAt: null, updatedAt: null};
const custom: CountryTemplate = {id: '10000000-0000-4000-8000-000000000001',
  key: 'custom:10000000-0000-4000-8000-000000000001', builtin: false, names: {'zh-CN': '测试模板'},
  defaultLanguage: 'zh-CN', countryLanguages: ['zh-CN'], countries: [], revision: 1,
  createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'};

let root: Root | undefined; let container: HTMLDivElement | undefined;
afterEach(() => {if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined;});

async function render(api: SelfHostedApi) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {root?.render(<CountryTemplateManager api={api} />); await Promise.resolve(); await Promise.resolve();});
}

describe('self-hosted template managers', () => {
  it('creates an empty country template from its name before showing the legacy table editor', async () => {
    const createCountryTemplate = vi.fn(async () => custom);
    const listCountryTemplates = vi.fn().mockResolvedValueOnce([builtin]).mockResolvedValue([builtin, custom]);
    const api = {listCountryTemplates, createCountryTemplate} as unknown as SelfHostedApi;
    await render(api);

    expect(container?.querySelector('table')).toBeNull();
    const input = container?.querySelector('input') as HTMLInputElement; const create = [...container!.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Create country template'))!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '测试模板');
      input.dispatchEvent(new Event('input', {bubbles: true}));});
    await act(async () => {create.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();});

    const language = getLanguage();
    expect(createCountryTemplate).toHaveBeenCalledWith({names: {[language]: '测试模板'}, defaultLanguage: language,
      countryLanguages: [language], countries: []});
    expect(container?.querySelector('table')).toBeTruthy();
    expect(container?.textContent).toContain('Add country');
  });

  it('opens the built-in countries in the old read-only editor and clones through the API', async () => {
    const language = getLanguage();
    const cloneCountryTemplate = vi.fn(async () => custom);
    const listCountryTemplates = vi.fn().mockResolvedValueOnce([builtin]).mockResolvedValue([builtin, custom]);
    const api = {listCountryTemplates, cloneCountryTemplate} as unknown as SelfHostedApi;
    await render(api);
    const defaultItem = [...container!.querySelectorAll('.item')].find(item => item.textContent?.includes('Default countries'))!;
    await act(async () => {defaultItem.dispatchEvent(new MouseEvent('click', {bubbles: true}));});

    expect(container?.querySelector('table')).toBeTruthy();
    expect([...container!.querySelectorAll('input')].some(input => ['China', '中国'].includes(input.value))).toBe(true);
    const clone = [...container!.querySelectorAll('button')].find(button => button.textContent?.includes('Clone country template'))!;
    await act(async () => {clone.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();});
    expect(cloneCountryTemplate).toHaveBeenCalledWith('builtin:default',
      {...builtin.names, [language]: `${builtin.names[language]} (${language === 'zh-CN' ? '副本' : 'copy'})`}, language);
  });
});
