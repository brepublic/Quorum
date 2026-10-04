import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {expect, it, vi} from 'vitest';
import SelfHostedWorkspace from './SelfHostedWorkspace';
import type {SelfHostedApi} from '../services/self-hosted-api';
import type {SelfHostedUser} from '../services/self-hosted-identity';
import {setLanguage} from '../i18n';
it('preselects the administrator rule instead of the latest built-in', async () => {
  setLanguage('en');
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const version = (id: string) => ({id, version: 12, names: {en: id}, status: 'PUBLISHED',
    languageAvailability: {supportedLanguages: ['en'], missing: []}});
  const createCommittee = vi.fn(() => new Promise(() => undefined));
  const api = {listCommittees: async () => [], listCommitteeTemplates: async () => [],
    listCountryTemplates: async () => [{id: 'countries', key: 'builtin:default', names: {en: 'Countries'},
      defaultLanguage: 'en', builtin: true, revision: 1, countries: [{stableKey: 'country', names: {en: 'Country'}}]}],
    listRulePackages: async () => [{scope: 'BUILTIN', key: 'builtin:beijing-academic', versions: [version('Built-in rules')]},
      {scope: 'SYSTEM', key: 'custom', versions: [version('Administrator default')]}],
    getCommitteeCreationDefaults: async () => ({defaultRulePackageVersionId: 'Administrator default'}), createCommittee};
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/committees']}><SelfHostedWorkspace
      user={{id: 'owner', isSystemAdmin: false} as SelfHostedUser} api={api as unknown as SelfHostedApi} logout={vi.fn()} /></MemoryRouter>));
    expect(host.querySelector('[role=option][aria-selected=true]')?.textContent).toBeDefined();
    const selected = host.querySelectorAll('[role=option][aria-selected=true]');
    expect(Array.from(selected).some(el => el.textContent === 'Administrator default')).toBe(true);
    const name = host.querySelector('input[required]') as HTMLInputElement;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Council');
      name.dispatchEvent(new Event('input', {bubbles: true}));});
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    expect(createCommittee).toHaveBeenCalledWith(expect.objectContaining({activeRulePackageVersionId: 'Administrator default'}));
  } finally {act(() => root.unmount()); host.remove();}
});
