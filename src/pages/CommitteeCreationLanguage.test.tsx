import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ContentLanguage} from '@quorum/contracts';
import SelfHostedWorkspace from './SelfHostedWorkspace';
import {setLanguage, useLanguage} from '../i18n';
import type {SelfHostedApi} from '../services/self-hosted-api';
import type {SelfHostedUser} from '../services/self-hosted-identity';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const user = {id: 'owner', displayName: 'Owner', isSystemAdmin: false} as SelfHostedUser;
let root: Root | undefined; let container: HTMLDivElement;
afterEach(() => {act(() => root?.unmount()); root = undefined; container?.remove(); setLanguage('en');});
function Page({api}: {api: SelfHostedApi}) {
  useLanguage();
  return <SelfHostedWorkspace user={user} api={api} logout={() => undefined} />;
}
const combinations: Array<[ContentLanguage, ContentLanguage]> = [['en','en'], ['en','zh-CN'], ['zh-CN','en'], ['zh-CN','zh-CN']];
describe('committee creation content language', () => {
  it.each(combinations)('keeps %s content while displaying the %s interface', async (contentLanguage, interfaceLanguage) => {
    setLanguage(contentLanguage);
    const createCommittee = vi.fn(() => new Promise(() => undefined));
    const api = {
      listCommittees: async () => [], listCommitteeTemplates: async () => [],
      listCountryTemplates: async () => [{id: 'countries', key: 'builtin:default', names: {en: 'Countries', 'zh-CN': '国家'},
        defaultLanguage: 'en', builtin: true, revision: 7, countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}}]}],
      listRulePackages: async () => [{scope: 'BUILTIN', key: 'builtin:quorum-default', versions: [{id: 'rules', names: {en: 'Default rules', 'zh-CN': '默认规则'}, version: 5,
        status: 'PUBLISHED', languageAvailability: {supportedLanguages: ['zh-CN', 'en'], missing: []}}]}],
      createCommittee
    } as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => {root!.render(<MemoryRouter initialEntries={['/committees']}><Page api={api} /></MemoryRouter>);});
    const input = container.querySelector<HTMLInputElement>('input[required]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Custom committee name');
      input.dispatchEvent(new Event('input', {bubbles: true})); input.focus(); input.setSelectionRange(2, 5);
    });
    act(() => setLanguage(interfaceLanguage));
    expect(container.querySelector('input[required]')).toBe(input);
    expect(input.value).toBe('Custom committee name');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    await act(async () => {container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    expect(createCommittee).toHaveBeenCalledWith(expect.objectContaining({name: 'Custom committee name', committeeLanguage: contentLanguage,
      activeRulePackageVersionId: 'rules', countryTemplateRevision: 7, countryTemplateKey: 'builtin:default'}));
  });
});
