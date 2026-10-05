import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter, useLocation} from 'react-router-dom';
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
  const location = useLocation();
  return <><output data-testid="creation-location">{location.pathname}</output>
    <SelfHostedWorkspace user={user} api={api} logout={() => undefined} /></>;
}
const combinations: Array<[ContentLanguage, ContentLanguage]> = [['en','en'], ['en','zh-CN'], ['zh-CN','en'], ['zh-CN','zh-CN']];
describe('committee creation content language', () => {
  it.each(combinations)('keeps %s content while displaying the %s interface', async (contentLanguage, interfaceLanguage) => {
    setLanguage(contentLanguage);
    let finishCreation!: (value: {id: string}) => void;
    const createCommittee = vi.fn(() => new Promise<{id: string}>(resolve => {finishCreation = resolve;}));
    const api = {
      listCommittees: async () => [], listCommitteeTemplates: async () => [],
      listCountryTemplates: async () => [{id: 'countries', key: 'builtin:default', names: {en: 'Countries', 'zh-CN': '国家'},
        defaultLanguage: 'en', builtin: true, revision: 7, countries: [{stableKey: 'china', names: {en: 'China', 'zh-CN': '中国'}}]}],
      getCommitteeCreationDefaults: async () => ({defaultRulePackageVersionId: 'rules'}), listRulePackages: async () => [{scope: 'BUILTIN', key: 'builtin:beijing-academic', versions: [
        {id: 'rules', names: {en: 'Beijing Academic Standard 2021', 'zh-CN': '北京学术标准 2021'}, version: 12,
          status: 'PUBLISHED', languageAvailability: {supportedLanguages: ['zh-CN', 'en'], missing: []}},
        {id: 'old-rules', names: {en: 'Beijing Academic Standard 2021', 'zh-CN': '北京学术标准 2021'}, version: 6,
          status: 'PUBLISHED', languageAvailability: {supportedLanguages: ['zh-CN', 'en'], missing: []}},
        {id: 'draft-rules', names: {en: 'Beijing Draft', 'zh-CN': '北京规则草稿'}, version: 13,
          status: 'DRAFT', languageAvailability: {supportedLanguages: ['zh-CN', 'en'], missing: []}}]},
        {scope: 'SYSTEM', key: 'system:custom', versions: [1, 2].map(version => ({id: `custom-${version}`, version,
          status: 'PUBLISHED', names: {en: `Custom Rules ${version}`},
          languageAvailability: {supportedLanguages: ['en'], missing: []}}))}],
      createCommittee, snapshot: vi.fn(() => new Promise(() => undefined))
    } as unknown as SelfHostedApi;
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => {root!.render(<MemoryRouter initialEntries={['/committees']}><Page api={api} /></MemoryRouter>);});
    const input = container.querySelector<HTMLInputElement>('input[required]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Custom committee name');
      input.dispatchEvent(new Event('input', {bubbles: true})); input.focus(); input.setSelectionRange(2, 5);
    });
    act(() => setLanguage(interfaceLanguage));
    const ruleName = interfaceLanguage === 'en' ? 'Beijing Academic Standard 2021' : '北京学术标准 2021';
    const ruleOptions = Array.from(container.querySelectorAll('[role="option"]')).filter(option => option.textContent === ruleName);
    expect(ruleOptions).toHaveLength(1);
    expect(container.textContent).not.toContain(interfaceLanguage === 'en' ? 'Beijing Draft' : '北京规则草稿');
    expect(container.textContent).toContain('Custom Rules 1'); expect(container.textContent).toContain('Custom Rules 2');
    expect(container.textContent).not.toContain(interfaceLanguage === 'en' ? '北京学术标准 2021' : 'Beijing Academic Standard 2021');
    expect(container.querySelector('input[required]')).toBe(input);
    expect(input.value).toBe('Custom committee name');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    await act(async () => {container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
    expect(createCommittee).toHaveBeenCalledWith(expect.objectContaining({name: 'Custom committee name', committeeLanguage: contentLanguage,
      activeRulePackageVersionId: 'rules', countryTemplateRevision: 7, countryTemplateKey: 'builtin:default'}));
    await act(async () => {finishCreation({id: 'new-committee'});});
    expect(container.querySelector('[data-testid="creation-location"]')?.textContent)
      .toBe('/committees/new-committee/info');
  });
});
