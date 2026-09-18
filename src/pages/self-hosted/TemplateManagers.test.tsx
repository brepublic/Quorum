import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CountryTemplate, CommitteeTemplate} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {getLanguage, setLanguage} from '../../i18n';
import {CountryTemplateManager, CommitteeTemplateManager} from './TemplateManagers';

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
afterEach(() => {if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; setLanguage('en');});

async function render(api: SelfHostedApi) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {root?.render(<CountryTemplateManager api={api} />); await Promise.resolve(); await Promise.resolve();});
}

describe('self-hosted template managers', () => {
  it('preserves the draft content language and focus when the interface language changes', async () => {
    setLanguage('en');
    const createCountryTemplate = vi.fn(async () => custom);
    const api = {listCountryTemplates: vi.fn(async () => [builtin]), createCountryTemplate} as unknown as SelfHostedApi;
    await render(api);
    const input = container!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original draft');
      input.dispatchEvent(new Event('input', {bubbles: true})); input.focus();
    });
    act(() => setLanguage('zh-CN'));
    expect(container!.querySelector('input')).toBe(input);
    expect(input.value).toBe('Original draft'); expect(document.activeElement).toBe(input);
    expect(container!.textContent).toContain('创建国家模板');
    await act(async () => {
      container!.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    });
    expect(createCountryTemplate).toHaveBeenCalledWith({names: {en: 'Original draft'}, defaultLanguage: 'en',
      countryLanguages: ['en'], countries: []});
    expect(api.listCountryTemplates).toHaveBeenCalledTimes(2);
  });

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


describe('committee template independent capabilities', () => {
  it('enables voting with veto, clears dependent flags, and saves the final independent values', async () => {
    const template: CommitteeTemplate = {id: 'cap-template', key: 'custom:cap-template', builtin: false,
      names: {en: 'Capabilities'}, defaultLanguage: 'en', countryTemplateKey: 'builtin:default', revision: 1,
      createdAt: null, updatedAt: null, members: [{id: 'member', stableKey: 'cn', names: {en: 'China'}, defaultLanguage: 'en',
        rank: 'OBSERVER', canVote: false, hasVeto: false, mustVote: false, sortOrder: 0,
        flag: {type: 'STANDARD', value: 'cn'}, revision: 1}]};
    const updateCommitteeTemplate = vi.fn(async () => template);
    const api = {listCommitteeTemplates: vi.fn(async () => [template]), listCountryTemplates: vi.fn(async () => [builtin]),
      updateCommitteeTemplate} as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => {root!.render(<CommitteeTemplateManager api={api} />);});
    await act(async () => {[...container!.querySelectorAll<HTMLElement>('.list .item')]
      .find(item => item.textContent?.includes('Capabilities'))!.click();});
    const row = () => container!.querySelector('tbody tr')!;
    const toggles = () => row().querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const click = async (index: number) => act(async () => {
      for (const type of ['mousedown', 'mouseup', 'click']) toggles()[index].parentElement!.dispatchEvent(new MouseEvent(type, {bubbles: true}));
    });
    await click(1);
    expect([...toggles()].map(input => input.checked)).toEqual([true, true, false]);
    await click(2);
    await click(0);
    expect([...toggles()].map(input => input.checked)).toEqual([false, false, false]);
    expect(toggles()[2].disabled).toBe(true);
    await click(1);
    await act(async () => {container!.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    expect(updateCommitteeTemplate).toHaveBeenCalledWith('cap-template', 1, expect.objectContaining({members: [expect.objectContaining({
      rank: 'OBSERVER', canVote: true, hasVeto: true, mustVote: false})]}));
  });
});
